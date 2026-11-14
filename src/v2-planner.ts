import { randomUUID } from 'node:crypto';
import { canonical, digest } from './canonical.js';
import { invariant } from './errors.js';
import type { ManifestItem, ResultItem } from './contracts.js';
import {
  readV2,
  type Descriptor,
  type RefSegment,
  type ResultBatch,
} from './v2-contracts.js';

export const V2_LIMITS = Object.freeze({
  files: 100,
  fileBytes: 104857600n,
  batchBytes: 1073741824n,
  itemBytes: 1073741824n,
  refsPerItem: 1000,
  jsonBytes: 16777216,
});
const encodedBytes = (batch: ResultBatch) =>
  Buffer.byteLength(canonical(batch), 'utf8');
export function uniqueFileBytes(manifest: readonly ManifestItem[]): bigint {
  const resources = new Map<string, { bytes: string; sha256: string }>();
  for (const file of manifest) {
    const key = file.fileId.toLowerCase(),
      old = resources.get(key);
    invariant(
      !old || (old.bytes === file.bytes && old.sha256 === file.sha256),
      'FILE_ID_CONFLICT',
      'One resource UUID has conflicting byte metadata.',
    );
    invariant(
      BigInt(file.bytes) <= V2_LIMITS.fileBytes,
      'FILE_BYTE_LIMIT',
      'A file exceeds the pinned single-file channel limit.',
    );
    resources.set(key, file);
  }
  return [...resources.values()].reduce(
    (sum, file) => sum + BigInt(file.bytes),
    0n,
  );
}
export function assertBatchBudget(batch: ResultBatch, includeJson = true) {
  const refs = new Set([
    ...batch.evidenceManifest.map((e) => e.localEvidenceId),
    ...batch.items.flatMap((x) => x.evidenceRefs),
    ...batch.evidenceSegments.flatMap((x) => x.evidenceRefs),
  ]);
  invariant(
    refs.size <= V2_LIMITS.files,
    'BATCH_EVIDENCE_LIMIT',
    'Batch involves more than 100 evidence identities.',
  );
  const size = encodedBytes(batch);
  invariant(
    size <= V2_LIMITS.jsonBytes,
    'BATCH_JSON_LIMIT',
    'Frozen batch exceeds the original JSON channel limit.',
  );
  invariant(
    uniqueFileBytes(batch.evidenceManifest) +
      (includeJson ? BigInt(size) : 0n) <=
      V2_LIMITS.batchBytes,
    'BATCH_BYTE_LIMIT',
    'Unique file bytes plus the exact original JSON exceed the batch budget.',
  );
}

/** Deterministic grouping of frozen facts; never reads/executes SUT or changes a result. */
export function planV2Batches(input: {
  runId: string;
  snapshotDigest: string;
  items: readonly ResultItem[];
  manifest: ReadonlyMap<string, ManifestItem>;
}): ResultBatch[] {
  const batches: ResultBatch[] = [];
  const empty = (): ResultBatch => ({
    schemaVersion: 'ath.result-batch.v2',
    runId: input.runId,
    snapshotDigest: input.snapshotDigest,
    batchId: randomUUID(),
    items: [],
    evidenceManifest: [],
    explicitNotExecutedItems: [],
    descriptors: [],
    evidenceSegments: [],
  });
  const evidence = (refs: readonly string[]) =>
    refs.map((ref) => {
      const file = input.manifest.get(ref);
      invariant(
        file,
        'EVIDENCE_NOT_FOUND',
        'A result references evidence missing from the frozen manifest.',
      );
      return structuredClone(file);
    });
  const merge = (batch: ResultBatch, refs: readonly string[]) => {
    const map = new Map(
      batch.evidenceManifest.map((x) => [x.localEvidenceId, x]),
    );
    for (const e of evidence(refs)) map.set(e.localEvidenceId, e);
    batch.evidenceManifest = [...map.values()];
  };
  const valid = (batch: ResultBatch) => {
    try {
      assertBatchBudget(batch);
      return true;
    } catch {
      return false;
    }
  };
  const add = (batch: ResultBatch) => {
    assertBatchBudget(batch);
    readV2<ResultBatch>('uiResultBatchSchema', batch);
    batches.push(structuredClone(batch));
  };
  let current = empty();
  const flush = () => {
    if (
      current.items.length ||
      current.descriptors.length ||
      current.evidenceSegments.length ||
      current.explicitNotExecutedItems.length
    )
      add(current);
    current = empty();
  };
  const seenItems = new Set<string>(),
    seenLocal = new Set<string>();
  for (const item of input.items) {
    invariant(
      !seenItems.has(item.runItemId) && !seenLocal.has(item.localResultId),
      'RESULT_ID_CONFLICT',
      'A delivery plan cannot duplicate result identity.',
    );
    seenItems.add(item.runItemId);
    seenLocal.add(item.localResultId);
    invariant(
      item.evidenceRefs.length <= V2_LIMITS.refsPerItem &&
        new Set(item.evidenceRefs).size === item.evidenceRefs.length,
      'RESULT_REFS_LIMIT',
      'Result refs must be unique and fit the per-item structural limit.',
    );
    invariant(
      uniqueFileBytes(evidence(item.evidenceRefs)) <= V2_LIMITS.itemBytes,
      'RESULT_BYTE_LIMIT',
      'One complete result exceeds the pinned file budget; it cannot be hidden by splitting batches.',
    );
    const single = empty();
    single.items = [structuredClone(item)];
    merge(single, item.evidenceRefs);
    if (valid(single)) {
      const trial = structuredClone(current);
      trial.items.push(structuredClone(item));
      merge(trial, item.evidenceRefs);
      if (!valid(trial)) {
        flush();
        current = single;
      } else current = trial;
      continue;
    }
    flush();
    const { evidenceRefs, ...core } = structuredClone(item),
      descriptorId = randomUUID();
    const segments: RefSegment[] = [];
    let refs: string[] = [],
      start = 0;
    const finishSegment = () => {
      if (refs.length) {
        segments.push({
          descriptorId,
          segmentIndex: segments.length,
          startIndex: start,
          evidenceRefs: refs,
        });
        start += refs.length;
        refs = [];
      }
    };
    for (const ref of evidenceRefs) {
      const trial = empty();
      trial.evidenceSegments = [
        {
          descriptorId,
          segmentIndex: segments.length,
          startIndex: start,
          evidenceRefs: [...refs, ref],
        },
      ];
      merge(trial, [...refs, ref]);
      // Reserve bounded descriptor metadata in the first segment before freezing it.
      const reserved = Buffer.byteLength(canonical(core), 'utf8') + 2048;
      if (
        refs.length &&
        (refs.length >= 100 ||
          !valid(trial) ||
          uniqueFileBytes(trial.evidenceManifest) +
            BigInt(encodedBytes(trial) + reserved) >
            V2_LIMITS.batchBytes)
      )
        finishSegment();
      refs.push(ref);
    }
    finishSegment();
    const descriptor: Descriptor = {
      descriptorId,
      core,
      expectedRefCount: evidenceRefs.length,
      segmentCount: segments.length,
      fullRefsDigest: digest(evidenceRefs),
      itemDigest: digest(item),
    };
    if (!segments.length) {
      const batch = empty();
      batch.descriptors = [descriptor];
      add(batch);
    }
    for (const segment of segments) {
      const batch = empty();
      if (segment.segmentIndex === 0) batch.descriptors = [descriptor];
      batch.evidenceSegments = [segment];
      merge(batch, segment.evidenceRefs);
      add(batch);
    }
  }
  flush();
  return batches;
}
