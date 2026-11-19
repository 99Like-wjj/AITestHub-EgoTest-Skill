import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import archiveContract from '../contracts/archive-v1.json' with { type: 'json' };
import { assertNoSecrets, digest, parseJson } from './canonical.js';
import {
  evidenceSchema,
  receiptSchema,
  submissionSchema,
} from './contracts.js';
import { invariant } from './errors.js';
import type { CommandPorts } from './commands.js';

const component = (name: keyof typeof archiveContract.schemas) =>
  z.fromJSONSchema(
    archiveContract.schemas[name] as Parameters<typeof z.fromJSONSchema>[0],
  );
const archiveInput = component('uiArchiveInputSchema');
const archivePreview = component('uiArchivePreviewSchema');
const sourceResult = component('archiveResultSchema');
const sourceEvidence = component('archiveEvidenceSchema');
const digitId = z.uuid();
const textId = z.string().min(1).max(200);
const sourceShape = z.object({
  localExecutionId: textId,
  endedAt: z.string(),
  items: z.array(
    z.object({ localItemId: textId, originalOutcome: z.string() }),
  ),
});
const receiptShape = z.object({
  runId: digitId,
  scope: z.object({
    runId: digitId,
    projectId: digitId,
    localExecutionId: textId,
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
    items: z.array(
      z.object({
        runItemId: digitId,
        localItemId: textId,
        declaredOutcome: z.string(),
      }),
    ),
  }),
});
const workspaceRecord = z.strictObject({
  source: z.unknown(),
  sourceDigest: z.string(),
  previewDigest: z.string(),
  archiveCommandId: digitId,
  submissionId: digitId,
  phase: z.enum([
    'prepared',
    'registering',
    'registered',
    'submitting',
    'complete',
  ]),
  receipt: z.unknown().optional(),
  submittedReceipt: z.unknown().optional(),
});
const reference = { projectId: digitId, localExecutionId: textId };
const requestSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('preview'),
    projectId: digitId,
    source: z.unknown(),
  }),
  z.strictObject({ op: z.literal('commit'), ...reference }),
  z.strictObject({ op: z.literal('recover'), ...reference }),
  z.strictObject({
    op: z.literal('submit'),
    ...reference,
    items: z.array(sourceResult),
    files: z.array(evidenceSchema),
  }),
  z.strictObject({ op: z.literal('recover-submission'), ...reference }),
]);
/** Produces the web import format without launching a browser or inventing an observation. */
export function exportUiArchive(input: unknown) {
  assertNoSecrets(input);
  const parsed = z
    .strictObject({
      execution: archiveInput,
      results: z.array(sourceResult).min(1),
      evidence: z.array(sourceEvidence).max(100).default([]),
    })
    .parse(input);
  const expectation = sourceShape.parse(parsed.execution);
  const declared = new Map(
    expectation.items.map((row) => [row.localItemId, row.originalOutcome]),
  );
  const facts = parsed.results.map((value) =>
    z.object({ localItemId: textId, originalOutcome: z.string() }).parse(value),
  );
  invariant(
    declared.size === expectation.items.length &&
      facts.length === declared.size &&
      new Set(facts.map((row) => row.localItemId)).size === declared.size &&
      facts.every(
        (row) => declared.get(row.localItemId) === row.originalOutcome,
      ),
    'ARCHIVE_ITEMS_MISMATCH',
    'Archive requires one original observation per unique declared item.',
  );
  return JSON.stringify(parsed, null, 2) + '\n';
}

export async function runUiArchiveCommand(ports: CommandPorts, raw: unknown) {
  ports.result.assertSafe(raw);
  assertNoSecrets(raw);
  const request = requestSchema.parse(raw),
    projectId = request.projectId;
  const source =
    request.op === 'preview' ? archiveInput.parse(request.source) : undefined;
  const localId =
    request.op === 'preview'
      ? sourceShape.parse(source).localExecutionId
      : request.localExecutionId;
  const key = 'archives/v1/' + digest([projectId, localId]) + '.json';
  const call = async (name: string, args: Record<string, unknown>) => {
    ports.result.assertSafe(args);
    return ports.result.read(
      await ports.tool.callTool(name, { ...args, projectId }),
    );
  };
  const readRegistration = (
    raw: unknown,
    state: z.infer<typeof workspaceRecord>,
  ) => {
    const response = component('uiArchiveReceiptSchema').parse(raw);
    const receipt = receiptShape.parse(response);
    const declared = sourceShape.parse(state.source).items;
    const known = new Map(
      receipt.scope.items.map((i) => [i.localItemId, i.declaredOutcome]),
    );
    invariant(
      receipt.runId === receipt.scope.runId &&
        receipt.scope.projectId === projectId &&
        receipt.scope.localExecutionId === localId &&
        receipt.scope.items.length === declared.length &&
        known.size === declared.length &&
        declared.every((i) => known.get(i.localItemId) === i.originalOutcome),
      'ARCHIVE_RECEIPT_MISMATCH',
      'Original registration could not be matched to local source.',
    );
    return { response, receipt };
  };
  const save = (data: z.infer<typeof workspaceRecord>) =>
    ports.workspace.writeTextAtomic(key, JSON.stringify(data));
  return ports.workspace.withExclusive(key, async () => {
    const stored = await ports.workspace.readText(key);
    const state = stored ? workspaceRecord.parse(parseJson(stored)) : undefined;
    if (request.op === 'preview') {
      const sourceDigest = digest(source);
      invariant(
        !state || state.sourceDigest === sourceDigest,
        'ARCHIVE_ID_CONFLICT',
        'This local execution identity belongs to different content.',
      );
      invariant(
        !state || state.phase === 'prepared',
        'ARCHIVE_ALREADY_SENT',
        'Read the original archive receipt.',
      );
      const response = archivePreview.parse(
        await call('ath_ui_archives', { op: 'preview', input: source }),
      );
      const { previewDigest } = z
        .object({ previewDigest: z.string() })
        .parse(response);
      await save({
        source,
        sourceDigest,
        previewDigest,
        archiveCommandId: state?.archiveCommandId ?? randomUUID(),
        submissionId: state?.submissionId ?? randomUUID(),
        phase: 'prepared',
      });
      return response;
    }
    invariant(
      state,
      'ARCHIVE_NOT_PREPARED',
      'Select and preview this exact local execution first.',
    );
    if (request.op === 'commit' || request.op === 'recover') {
      if (state.receipt) return readRegistration(state.receipt, state).response;
      if (request.op === 'commit') {
        invariant(
          state.phase === 'prepared',
          'ARCHIVE_OUTCOME_UNKNOWN',
          'Read original registration status before any further action.',
        );
        await save({ ...state, phase: 'registering' });
      } else
        invariant(
          state.phase === 'registering',
          'ARCHIVE_NOT_SENT',
          'No registration was dispatched.',
        );
      const rawReceipt =
        request.op === 'recover'
          ? await call('ath_ui_archives', {
              op: 'receipt',
              commandId: state.archiveCommandId,
            })
          : await call('ath_ui_archives', {
              op: 'commit',
              input: {
                input: state.source,
                previewDigest: state.previewDigest,
                commandId: state.archiveCommandId,
              },
            });
      const { response } = readRegistration(rawReceipt, state);
      await save({ ...state, phase: 'registered', receipt: response });
      return response;
    }
    invariant(
      state.receipt,
      'ARCHIVE_NOT_REGISTERED',
      'The original registration receipt is required.',
    );
    const { receipt } = readRegistration(state.receipt, state);
    if (state.submittedReceipt)
      return receiptSchema.parse(state.submittedReceipt);
    if (request.op === 'recover-submission') {
      invariant(
        state.phase === 'submitting',
        'ARCHIVE_NOT_SENT',
        'No result submission was dispatched.',
      );
      const response = z.object({ receipt: receiptSchema }).parse(
        await call('ath_results', {
          op: 'receipt',
          submissionId: state.submissionId,
        }),
      ).receipt;
      invariant(
        response.submissionId === state.submissionId,
        'ARCHIVE_RECEIPT_MISMATCH',
        'Original result receipt mismatch.',
      );
      await save({ ...state, phase: 'complete', submittedReceipt: response });
      return response;
    }
    invariant(
      state.phase === 'registered',
      'ARCHIVE_OUTCOME_UNKNOWN',
      'Read original submission status before any further action.',
    );
    const ids = new Map(
      receipt.scope.items.map((i) => [i.localItemId, i.runItemId]),
    );
    const items = request.items.map((value) => {
      const row = z.object({ localItemId: textId }).passthrough().parse(value);
      const { localItemId, ...fact } = row;
      return { ...fact, runItemId: ids.get(localItemId) };
    });
    const submission = submissionSchema.parse({
      schemaVersion: 'ath.result-submission.v1',
      runId: receipt.runId,
      submissionId: state.submissionId,
      snapshotDigest: receipt.scope.snapshotDigest,
      completion: 'complete',
      endedAt: sourceShape.parse(state.source).endedAt,
      items,
      evidenceManifest: request.files,
      notExecutedItemIds: [],
    });
    await save({ ...state, phase: 'submitting' });
    const response = receiptSchema.parse(
      await call('ath_results', { op: 'commit', input: submission }),
    );
    invariant(
      response.submissionId === state.submissionId,
      'ARCHIVE_RECEIPT_MISMATCH',
      'Original result receipt mismatch.',
    );
    await save({ ...state, phase: 'complete', submittedReceipt: response });
    return response;
  });
}
