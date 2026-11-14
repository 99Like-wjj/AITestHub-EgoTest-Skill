import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { z } from 'zod';
import { canonical, digest, bytesHash } from './canonical.js';
import { invariant, LocalError, safeErrorCode } from './errors.js';
import {
  progressSchema,
  submissionSchema,
  receiptSchema,
  id,
  sha,
  bytes,
} from './contracts.js';
import type { Receipt } from './contracts.js';
import {
  ExecutionStore,
  safeRelativeEvidence,
  resultPayload,
} from './store.js';
import type { LocalEvidence, Outbox } from './store.js';
import type {
  ToolPort,
  ResultPort,
  FileChannelPort,
  ClientFailure,
  RegisteredFile,
} from './ports.js';
import { validateToolInput } from './platform-schema.js';

export interface RuntimePorts {
  tool: ToolPort;
  result: ResultPort;
  files: FileChannelPort;
  privateRoot: string;
}
export class ExecutionClient {
  constructor(
    readonly store: ExecutionStore,
    readonly ports: RuntimePorts,
  ) {
    invariant(
      isAbsolute(ports.privateRoot),
      'UNSAFE_PATH',
      'The coordinated workspace requires an explicit absolute private root.',
    );
  }
  evidencePath(relativePath: string): string {
    safeRelativeEvidence(relativePath);
    const root = resolve(this.ports.privateRoot, this.store.prefix),
      target = resolve(root, relativePath),
      rel = relative(root, target);
    invariant(
      !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`),
      'UNSAFE_PATH',
      'Evidence path escaped this run.',
    );
    return target;
  }
  async indexEvidence(input: Omit<LocalEvidence, 'sha256' | 'bytes'>) {
    const actual = await this.ports.files.inspectFile(
      this.evidencePath(input.relativePath),
    );
    await this.store.indexEvidence({ ...input, ...actual });
    return {
      localEvidenceId: input.localEvidenceId,
      ...actual,
      sourceFactNotProvenByHash: true,
    };
  }
  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.ports.result.assertSafe(args);
    validateToolInput(name, args);
    const raw = await this.ports.tool.callTool(name, structuredClone(args)),
      value = this.ports.result.read(raw);
    this.ports.result.assertSafe(value);
    return value;
  }
  async uploadEvidence(
    localEvidenceId: string,
    explicitRetransmissionReason?: string,
  ) {
    return this.store.workspace.withExclusive(
      `${this.store.prefix}/file-transfer`,
      async () => {
        const view = await this.store.read(),
          e = view.evidence.get(localEvidenceId);
        invariant(
          e,
          'EVIDENCE_NOT_FOUND',
          'Evidence must be indexed before platform upload.',
        );
        invariant(
          e.upload === 'local' ||
            (e.upload !== 'verified' &&
              e.lastRecovery !== undefined &&
              explicitRetransmissionReason?.trim()),
          'FILE_RECOVERY_REQUIRED',
          'A prior upload identity exists; query its receipt before an explicit full retransmission.',
        );
        invariant(
          BigInt(e.bytes) <= 104857600n,
          'FILE_BYTE_LIMIT',
          'Indexed evidence exceeds the platform 100MiB file channel; original data remains local.',
        );
        const localFileId = `ath-e-${digest({ runId: view.scope.runId, localEvidenceId: e.localEvidenceId })}`;
        await this.store.beginFileUpload(localEvidenceId, localFileId);
        try {
          const result = await this.ports.files.uploadFile({
            projectId: view.scope.projectId,
            runId: view.scope.runId,
            absolutePath: this.evidencePath(e.relativePath),
            localFileId,
            originalName: e.originalName,
            mediaType: e.mediaType,
            expected: { bytes: e.bytes, sha256: e.sha256 },
            onRegistered: async (registered) => {
              this.checkFile(registered, e);
              invariant(
                registered.localFileId === localFileId,
                'FILE_ID_CONFLICT',
                'Registration has another local identity.',
              );
              await this.store.fileStatus(
                localEvidenceId,
                'registered',
                registered,
              );
            },
          });
          const registered = (await this.store.read()).evidence.get(
            localEvidenceId,
          );
          invariant(
            registered?.fileId === result.fileId &&
              result.status === 'verified' &&
              result.localFileId === localFileId,
            'UNVERIFIED_FILE',
            'Upload did not retain its original registration and verified receipt.',
          );
          this.checkFile(result, e);
          await this.store.fileStatus(localEvidenceId, 'verified', result);
          return result;
        } catch (error) {
          await this.store.fileStatus(localEvidenceId, 'unknown');
          throw this.safeFailure(error);
        }
      },
    );
  }
  private checkFile(
    value: RegisteredFile,
    expected: { bytes: string; sha256: string },
  ) {
    id.parse(value.fileId);
    sha.parse(value.sha256);
    bytes.parse(value.bytes);
    invariant(
      value.bytes === expected.bytes && value.sha256 === expected.sha256,
      'FILE_DIGEST_MISMATCH',
      'Platform file receipt differs from the indexed original.',
    );
  }
  async recoverEvidence(localEvidenceId: string) {
    const v = await this.store.read(),
      e = v.evidence.get(localEvidenceId);
    invariant(
      e?.localFileId,
      'FILE_NOT_REGISTERED',
      'No prior local upload identity exists.',
    );
    if (!e.fileId) {
      const value = {
        status: 'registration-unconfirmed',
        localFileId: e.localFileId,
        retransmissionNotAutomatic: true,
      };
      await this.store.recoveredFile(localEvidenceId, value);
      return value;
    }
    const raw = await this.call('ath_file_transfers', {
        op: 'receipt',
        fileId: e.fileId,
      }),
      parsed = z
        .object({
          file: z
            .object({
              id,
              projectId: id.nullable(),
              runId: id.nullable(),
              sha256: sha,
              bytes,
              status: z.enum(['pending', 'uploading', 'verified', 'failed']),
            })
            .passthrough(),
        })
        .parse(raw);
    invariant(
      parsed.file.id === e.fileId &&
        parsed.file.projectId === v.scope.projectId &&
        parsed.file.runId === v.scope.runId,
      'FILE_SCOPE_MISMATCH',
      'Recovered file belongs to another run/project.',
    );
    this.checkFile(
      { ...parsed.file, fileId: parsed.file.id, localFileId: e.localFileId },
      e,
    );
    const value = {
      fileId: e.fileId,
      status: parsed.file.status,
      retransmissionNotAutomatic: true,
    };
    await this.store.recoveredFile(localEvidenceId, value);
    if (parsed.file.status === 'verified')
      await this.store.fileStatus(localEvidenceId, 'verified', {
        fileId: e.fileId,
        localFileId: e.localFileId,
        bytes: e.bytes,
        sha256: e.sha256,
      });
    return value;
  }
  async prepareProgress(summary: string, final = false) {
    return this.store.workspace.withExclusive(
      `${this.store.prefix}/prepare-outbox`,
      async () => {
        const v = await this.store.read();
        invariant(
          ![...v.outboxes.values()].some(
            (x) =>
              x.kind === 'progress' &&
              ['prepared', 'dispatched', 'unknown'].includes(x.status),
          ),
          'OUTBOX_RECOVERY_REQUIRED',
          'Resolve the original progress payload before preparing another sequence.',
        );
        const completed = [...v.results.values()].filter(
            (x) => x.item.originalOutcome !== 'notExecuted',
          ).length,
          previous = [...v.outboxes.values()]
            .filter((x) => x.kind === 'progress')
            .map((x) => progressSchema.parse(x.args.input)),
          last = previous.at(-1);
        if (!final && completed - (last?.completedItems ?? 0) < 10)
          return { due: false as const, completedItems: completed };
        const payload = progressSchema.parse({
            runId: v.scope.runId,
            sequence: (last?.sequence ?? 0) + 1,
            completedItems: completed,
            summary,
            observedAt: new Date().toISOString(),
          }),
          outbox: Omit<Outbox, 'status'> = {
            outboxId: randomUUID(),
            kind: 'progress',
            tool: 'ath_ui_executions',
            args: {
              op: 'progress',
              projectId: v.scope.projectId,
              input: payload,
            },
            payloadDigest: '',
          };
        outbox.payloadDigest = digest(outbox.args);
        await this.store.addOutbox(outbox);
        return { due: true as const, outboxId: outbox.outboxId, payload };
      },
    );
  }
  async prepareResults(input: {
    completion: 'partial' | 'complete';
    endedAt?: string;
    notExecutedItemIds?: string[];
    allowPendingFiles?: boolean;
  }) {
    return this.store.workspace.withExclusive(
      `${this.store.prefix}/prepare-outbox`,
      async () => {
        const v = await this.store.read();
        invariant(
          ![...v.outboxes.values()].some(
            (x) =>
              x.kind === 'result' &&
              ['prepared', 'dispatched', 'unknown'].includes(x.status),
          ),
          'OUTBOX_RECOVERY_REQUIRED',
          'Resolve the original result submission before preparing another one.',
        );
        const items = [...v.results.values()].map((x) => x.item),
          refs = [...new Set(items.flatMap((x) => x.evidenceRefs))];
        invariant(
          refs.length <= 100,
          'DELIVERY_CONTRACT_LIMIT',
          'Current platform permits 100 manifest entries per full submission; all local evidence is retained. Do not drop refs, images or change the fixed scope.',
        );
        const evidenceManifest = refs.map((ref) => {
          const e = v.evidence.get(ref);
          invariant(
            e?.fileId,
            'FILE_NOT_REGISTERED',
            'Every referenced evidence file needs its real platform registration.',
          );
          invariant(
            e.upload === 'verified' || input.allowPendingFiles === true,
            'FILE_NOT_VERIFIED',
            'Evidence is not verified; explicitly declare pending delivery or complete the original upload.',
          );
          const {
            localEvidenceId,
            fileId,
            type,
            sha256,
            bytes,
            captureCompleteness,
            source,
            capturedAt,
          } = e;
          return {
            localEvidenceId,
            fileId,
            type,
            sha256,
            bytes,
            captureCompleteness,
            source,
            ...(capturedAt === undefined ? {} : { capturedAt }),
          };
        });
        const files = new Map(
          evidenceManifest.map((x) => [x.fileId, BigInt(x.bytes)]),
        );
        invariant(
          [...files.values()].reduce((a, b) => a + b, 0n) <= 1073741824n,
          'DELIVERY_BYTE_LIMIT',
          'This submission exceeds the platform 1GiB unique-file budget; data was not truncated.',
        );
        const payload = submissionSchema.parse({
          schemaVersion: 'ath.result-submission.v1',
          runId: v.scope.runId,
          submissionId: randomUUID(),
          snapshotDigest: v.scope.snapshotDigest,
          completion: input.completion,
          endedAt: input.endedAt ?? new Date().toISOString(),
          items,
          evidenceManifest,
          notExecutedItemIds: input.notExecutedItemIds ?? [],
        });
        resultPayload(v, payload);
        invariant(
          Buffer.byteLength(canonical(payload), 'utf8') <= 16 * 1024 * 1024,
          'DELIVERY_JSON_LIMIT',
          'Result payload exceeds the current 16MiB portable JSON channel; data remains local.',
        );
        const args = {
            op: 'commit',
            projectId: v.scope.projectId,
            input: payload,
          },
          outboxId = randomUUID();
        await this.store.addOutbox({
          outboxId,
          kind: 'result',
          tool: 'ath_results',
          args,
          payloadDigest: digest(args),
        });
        return {
          outboxId,
          payload,
          scopeItems: v.scope.items.length,
          submittedItems:
            payload.items.length + payload.notExecutedItemIds.length,
          executionStateNotInferredFromDelivery: true,
        };
      },
    );
  }
  async prepareRemote(outboxId: string) {
    const v = await this.store.read(),
      o = v.outboxes.get(outboxId);
    invariant(
      o?.kind === 'result',
      'OUTBOX_NOT_FOUND',
      'Result outbox required.',
    );
    return this.call('ath_results', { ...o.args, op: 'prepare' });
  }
  async exportResultJson(outboxId: string) {
    return this.store.workspace.withExclusive(
      `${this.store.prefix}/export-json`,
      async () => {
        const v = await this.store.read(),
          o = v.outboxes.get(outboxId);
        invariant(
          o?.kind === 'result',
          'OUTBOX_NOT_FOUND',
          'A frozen result payload is required.',
        );
        const text = canonical(o.args.input),
          relativePath = `evidence/result-${outboxId}.json`,
          fileKey = `${this.store.prefix}/${relativePath}`;
        const existing = await this.store.workspace.readText(fileKey);
        invariant(
          existing === null || existing === text,
          'ORIGINAL_JSON_MISMATCH',
          'Existing original JSON changed; it was preserved without overwrite.',
        );
        if (existing === null)
          await this.store.workspace.writeTextAtomic(fileKey, text);
        const localEvidenceId = `result-json:${outboxId}`,
          actual = await this.ports.files.inspectFile(
            this.evidencePath(relativePath),
          );
        invariant(
          actual.sha256 === bytesHash(Buffer.from(text, 'utf8')) &&
            actual.bytes === String(Buffer.byteLength(text, 'utf8')),
          'ORIGINAL_JSON_MISMATCH',
          'File channel did not inspect the frozen JSON bytes.',
        );
        await this.store.indexEvidence({
          localEvidenceId,
          relativePath,
          originalName: `result-${outboxId}.json`,
          mediaType: 'application/json',
          type: 'attachment',
          captureCompleteness: 'full',
          source: 'original',
          ...actual,
        });
        return {
          outboxId,
          localEvidenceId,
          relativePath,
          ...actual,
          uploaded: false,
        };
      },
    );
  }
  async attachResultJson(outboxId: string, localEvidenceId: string) {
    await this.store.attachResultJson(outboxId, localEvidenceId);
    return { outboxId, transport: 'submit-file', payloadUnchanged: true };
  }
  private validateReceipt(o: Outbox, value: unknown): Receipt {
    const receipt = receiptSchema.parse(value),
      payload = submissionSchema.parse(o.args.input),
      ids = [
        ...payload.items.map((x) => x.runItemId),
        ...payload.notExecutedItemIds,
      ];
    invariant(
      receipt.submissionId === payload.submissionId &&
        receipt.semanticDigest === digest(payload),
      'RECEIPT_MISMATCH',
      'Receipt does not match this frozen original submission.',
    );
    invariant(
      receipt.perItemResults.length === ids.length &&
        new Set(receipt.perItemResults.map((x) => x.objectId)).size ===
          ids.length &&
        receipt.perItemResults.every((x) => ids.includes(x.objectId)),
      'RECEIPT_SCOPE_MISMATCH',
      'Receipt item set differs from the exact original scope.',
    );
    invariant(
      receipt.resultsAccepted ===
        receipt.perItemResults.filter((x) => x.status === 'accepted').length,
      'RECEIPT_COUNT_MISMATCH',
      'Receipt accepted count is inconsistent.',
    );
    return receipt;
  }
  private safeFailure(error: unknown): LocalError {
    const e = error as Partial<ClientFailure>;
    return new LocalError(
      safeErrorCode(error),
      e.certainty === 'knownFailed'
        ? 'Platform rejected the original operation; sensitive detail omitted.'
        : 'Original outcome is unconfirmed; query its receipt, do not repeat SUT actions.',
    );
  }
  async dispatch(outboxId: string, explicitOriginalReplayReason?: string) {
    const v = await this.store.read(),
      o = v.outboxes.get(outboxId);
    invariant(o, 'OUTBOX_NOT_FOUND', 'No such original outbox.');
    invariant(
      digest(o.args) === o.payloadDigest,
      'OUTBOX_DIGEST_MISMATCH',
      'Original payload changed.',
    );
    await this.store.outboxStatus(
      outboxId,
      'dispatched',
      undefined,
      explicitOriginalReplayReason,
    );
    try {
      const actual = o.transportArgs ?? o.args;
      if (o.transportArgs)
        invariant(
          digest(o.transportArgs) === o.transportDigest,
          'OUTBOX_DIGEST_MISMATCH',
          'Original JSON transport changed.',
        );
      const value = await this.call(o.tool, actual);
      if (o.kind === 'result') {
        const receipt = this.validateReceipt(o, value);
        await this.store.outboxStatus(outboxId, 'acknowledged', receipt);
        return {
          status: 'acknowledged' as const,
          receipt,
          hasConflicts: receipt.perItemResults.some(
            (x) => x.status === 'conflict' || x.status === 'rejected',
          ),
        };
      }
      const receipt = z
        .object({
          accepted: z.literal(true),
          sequence: z.number().int(),
          progressClosedAt: z.string().nullable(),
        })
        .passthrough()
        .parse(value);
      invariant(
        receipt.sequence === progressSchema.parse(o.args.input).sequence,
        'RECEIPT_MISMATCH',
        'Progress receipt has another sequence.',
      );
      await this.store.outboxStatus(outboxId, 'acknowledged', receipt);
      return { status: 'acknowledged' as const, receipt };
    } catch (error) {
      const e = error as Partial<ClientFailure>,
        known =
          e.certainty === 'knownFailed' || e.certainty === 'notDispatched';
      await this.store.outboxStatus(outboxId, known ? 'rejected' : 'unknown', {
        code: safeErrorCode(error),
        certainty: known ? e.certainty : 'unknown',
      });
      throw this.safeFailure(error);
    }
  }
  async recover(outboxId: string) {
    const v = await this.store.read(),
      o = v.outboxes.get(outboxId);
    invariant(o, 'OUTBOX_NOT_FOUND', 'No original outbox.');
    if (o.kind === 'progress') {
      const value = {
        state: 'progress-status-unavailable',
        originalSequence: progressSchema.parse(o.args.input).sequence,
        automaticReplay: false,
      };
      await this.store.recovered(outboxId, value);
      return value;
    }
    const payload = submissionSchema.parse(o.args.input);
    try {
      const raw = await this.call('ath_results', {
          op: 'receipt',
          projectId: v.scope.projectId,
          submissionId: payload.submissionId,
        }),
        data = z
          .object({
            receipt: z.unknown(),
            currentDelivery: z.unknown().optional(),
          })
          .passthrough()
          .parse(raw),
        receipt = this.validateReceipt(o, data.receipt);
      await this.store.recovered(outboxId, {
        state: 'found',
        currentDelivery: data.currentDelivery ?? null,
      });
      await this.store.acceptRecovered(outboxId, receipt);
      return { state: 'found', receipt, currentDelivery: data.currentDelivery };
    } catch (error) {
      const e = error as Partial<ClientFailure>;
      const value = {
        state: e.code === 'NOT_FOUND' ? 'not-found-currently' : 'unconfirmed',
        code: safeErrorCode(error),
        originalOperationMayHaveOccurred: true,
        automaticReplay: false,
      };
      await this.store.recovered(outboxId, value);
      return value;
    }
  }
  async summary() {
    const v = await this.store.read();
    return {
      runId: v.scope.runId,
      scopeDigest: v.scope.snapshotDigest,
      totalItems: v.scope.items.length,
      recordedItems: v.results.size,
      unresolvedActions: [...v.actions.values()].filter((x) =>
        ['intent', 'dispatched', 'unknown'].includes(x.status),
      ),
      evidence: [...v.evidence.values()].map((x) => ({
        localEvidenceId: x.localEvidenceId,
        upload: x.upload,
        fileId: x.fileId ?? null,
        bytes: x.bytes,
        sha256: x.sha256,
      })),
      outboxes: [...v.outboxes.values()].map((x) => ({
        outboxId: x.outboxId,
        kind: x.kind,
        status: x.status,
        payloadDigest: x.payloadDigest,
      })),
      judgmentsAreCallerProvided: true,
    };
  }
}
