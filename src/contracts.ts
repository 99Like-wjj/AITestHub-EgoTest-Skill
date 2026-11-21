import { z } from 'zod';
import archiveContract from '../contracts/archive-v1.json' with { type: 'json' };
import { digest, assertNoSecrets } from './canonical.js';
import { invariant } from './errors.js';
import { platformSchema } from './platform-schema.js';

// Local primitives describe bookkeeping. Platform validation comes from the
// immutable exported JSON Schema, not a second hand-maintained runtime schema.
export const id = z.uuid();
export const localId = z.string().min(1).max(200);
export const key = z.string().min(8).max(128);
export const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const bytes = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const time = z.iso.datetime({ offset: true });
export type Outcome =
  'passed' | 'failed' | 'blocked' | 'inconclusive' | 'notExecuted';
export type SideEffectCertainty = 'known' | 'unknown' | 'notApplicable';
export interface StepObservation {
  ordinal: number;
  actual: string;
  outcome?: Outcome | undefined;
  evidenceRefs: string[];
}
export interface EvidenceGap {
  ordinal?: number | undefined;
  label: string;
  state: 'notCaptured' | 'pendingUpload' | 'uploadFailed';
  reason: string;
}
export interface ScopeItem {
  runItemId: string;
  caseId: string;
  approvalSnapshotId: string;
  requirementVersionId: string;
  setId: string;
  scenarioId: string;
  ordinal: number;
  issueIds: string[];
  scenario: {
    kind: 'UI';
    setId: string;
    requirementVersionId: string;
    title: string;
    [key: string]: unknown;
  };
  content: {
    kind: 'UI';
    scenarioId: string;
    title: string;
    steps?: { action: string; expected?: string | undefined }[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface ExecutionScope {
  schemaVersion: 'ath.execution-scope.v1';
  runId: string;
  projectId: string;
  kind: 'UI';
  sourceType: 'plan' | 'retestPreparation';
  sourceRevisionId: string;
  environmentId: string;
  environmentRevisionId: string;
  productBuild: string | null;
  snapshotDigest: string;
  items: ScopeItem[];
  missingRequirements: unknown[];
  [key: string]: unknown;
}
export interface ResultItem {
  runItemId: string;
  localResultId: string;
  originalOutcome: Outcome;
  actualObservations: string;
  sideEffectCertainty: SideEffectCertainty;
  evidenceRefs: string[];
  stepObservations?: StepObservation[] | undefined;
  evidenceGaps?: EvidenceGap[] | undefined;
  actualActions?: string[] | undefined;
  reason?: string | undefined;
  basis?: unknown[] | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
}
export interface ManifestItem {
  localEvidenceId: string;
  fileId: string;
  sha256: string;
  bytes: string;
  type:
    | 'screenshot'
    | 'requestResponse'
    | 'conversation'
    | 'log'
    | 'attachment'
    | 'other';
  captureCompleteness:
    'full' | 'viewport' | 'partial' | 'summary' | 'interrupted' | 'missing';
  source: 'original' | 'derived' | 'manualAddition';
  capturedAt?: string | undefined;
}
export interface Submission {
  schemaVersion: 'ath.result-submission.v1';
  runId: string;
  submissionId: string;
  snapshotDigest: string;
  completion: 'partial' | 'complete';
  endedAt: string;
  items: ResultItem[];
  evidenceManifest: ManifestItem[];
  notExecutedItemIds: string[];
}
export interface Receipt {
  submissionId: string;
  semanticDigest: string;
  resultsAccepted: number;
  missingFileIds: string[];
  deliveryStatus: 'notSubmitted' | 'receiving' | 'incomplete' | 'complete';
  reportId: string | null;
  reportUrl: string | null;
  perItemResults: {
    objectId: string;
    status: 'accepted' | 'conflict' | 'rejected' | 'skipped';
    revisionId?: string | undefined;
    code?: string | undefined;
    message?: string | undefined;
  }[];
}
export interface Progress {
  runId: string;
  sequence: number;
  completedItems: number;
  summary: string;
  observedAt: string;
}

// Types are a consumed-field view; JSON Schema is the structural runtime authority.
// Server refinements/CAS/ACL remain authoritative.
export const scopeSchema = z.fromJSONSchema(
  archiveContract.schemas.executionScopeSchema as Parameters<
    typeof z.fromJSONSchema
  >[0],
);
export const evidenceSchema = platformSchema(
  'domain.evidenceManifestItemSchema',
) as z.ZodType<ManifestItem>;
export function normalizeResultEvidence(item: ResultItem): ResultItem {
  const { stepObservations, evidenceGaps } = item;
  if (stepObservations === undefined && evidenceGaps === undefined) return item;
  return {
    ...item,
    ...(stepObservations === undefined
      ? {}
      : {
          stepObservations: stepObservations.map((step) => ({
            ...step,
            actual: step.actual.trim(),
            evidenceRefs: step.evidenceRefs ?? [],
          })),
        }),
    ...(evidenceGaps === undefined
      ? {}
      : {
          evidenceGaps: evidenceGaps.map((gap) => ({
            ...gap,
            label: gap.label.trim(),
            reason: gap.reason.trim(),
          })),
        }),
  };
}
export function validateResultEvidence(item: ResultItem, fixed?: ScopeItem) {
  const observations = item.stepObservations ?? [],
    gaps = item.evidenceGaps ?? [];
  if (!observations.length && !gaps.length) return;
  invariant(
    new Set(observations.map((step) => step.ordinal)).size ===
      observations.length,
    'DUPLICATE_STEP_OBSERVATION',
    'Record one original observation per frozen step.',
  );
  invariant(
    observations.every((step) => step.actual.trim()) &&
      gaps.every((gap) => gap.label.trim() && gap.reason.trim()),
    'RESULT_EVIDENCE_TEXT_REQUIRED',
    'Step observations and evidence gaps need non-blank text.',
  );
  const evidence = new Set(item.evidenceRefs);
  invariant(
    observations.every((step) =>
      (step.evidenceRefs ?? []).every((ref) => evidence.has(ref)),
    ),
    'STEP_EVIDENCE_OUTSIDE_RESULT',
    'Step evidence must be referenced by the same original result.',
  );
  if (fixed) {
    const available = fixed.content.steps?.length ?? 0;
    invariant(
      observations.every((step) => step.ordinal <= available) &&
        gaps.every(
          (gap) => gap.ordinal === undefined || gap.ordinal <= available,
        ),
      'STEP_OUTSIDE_FROZEN_CASE',
      'Step evidence must point to a frozen UI case step. Older cases can use an unnumbered gap.',
    );
  }
}
export const resultSchema = (
  platformSchema('domain.resultItemSchema') as z.ZodType<ResultItem>
).transform((item) => {
  const normalized = normalizeResultEvidence(item);
  validateResultEvidence(normalized);
  return normalized;
});
export const receiptSchema = platformSchema(
  'domain.resultSubmissionReceiptSchema',
) as z.ZodType<Receipt>;
export const progressSchema = platformSchema(
  'domain.uiProgressInputSchema',
) as z.ZodType<Progress>;
export const submissionSchema = (
  platformSchema('domain.resultSubmissionSchema') as z.ZodType<Submission>
)
  .transform((submission) => ({
    ...submission,
    items: submission.items.map(normalizeResultEvidence),
  }))
  .superRefine((x, ctx) => {
    // Exported JSON Schema cannot represent the server's cross-field refinements.
    for (const item of x.items) validateResultEvidence(item);
    const ids = [...x.items.map((y) => y.runItemId), ...x.notExecutedItemIds];
    if (
      new Set(ids).size !== ids.length ||
      new Set(x.items.map((y) => y.localResultId)).size !== x.items.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate/overlapping result identity.',
      });
    const refs = new Set(x.evidenceManifest.map((y) => y.localEvidenceId));
    if (
      refs.size !== x.evidenceManifest.length ||
      x.items.some((y) => y.evidenceRefs.some((r) => !refs.has(r)))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Evidence references must be unique and present in this submission manifest.',
      });
  });

export function scope(value: unknown): ExecutionScope {
  assertNoSecrets(value);
  scopeSchema.parse(value);
  const raw = value as ExecutionScope,
    { snapshotDigest: expected, ...without } = raw;
  invariant(
    raw.kind === 'UI' && ['plan', 'retestPreparation'].includes(raw.sourceType),
    'UNSUPPORTED_SCOPE',
    'Only approved UI plan/direct-retest scope is executable here.',
  );
  invariant(
    digest(without) === expected,
    'SCOPE_DIGEST_MISMATCH',
    'Fixed scope digest does not match its original JSON.',
  );
  invariant(
    new Set(raw.items.map((x) => x.runItemId)).size === raw.items.length &&
      new Set(raw.items.map((x) => x.ordinal)).size === raw.items.length,
    'DUPLICATE_SCOPE_ITEM',
    'Scope item IDs and ordinals must be unique.',
  );
  for (const x of raw.items)
    invariant(
      x.scenario.kind === 'UI' &&
        x.content.kind === 'UI' &&
        x.content.scenarioId === x.scenarioId &&
        x.scenario.setId === x.setId &&
        x.scenario.requirementVersionId === x.requirementVersionId,
      'SCOPE_CONTEXT_MISMATCH',
      'Fixed item context is inconsistent.',
    );
  return structuredClone(raw);
}
export const identitySchema = z.strictObject({
  actorId: id,
  platformOrigin: z.url().refine((x) => {
    const u = new URL(x);
    return (
      u.origin === x &&
      !u.username &&
      !u.password &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    );
  }, 'Expected a configured platform origin (HTTPS or local loopback).'),
  localExecutionId: key,
  executionProvenance: z.enum(['local-ai', 'protocol-synthetic', 'unknown']),
});
export type Identity = z.infer<typeof identitySchema>;
