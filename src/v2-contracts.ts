import { z } from 'zod';
import snapshot from '../contracts/ae7aca39-90be-4630-9b36-c5abcab63cfe-v2.json' with { type: 'json' };
import { invariant } from './errors.js';
import type { ManifestItem, ResultItem } from './contracts.js';

type Node = Record<string, unknown>;
const cache = new Map<string, z.ZodType>();
function leaves(raw: unknown, defs: Node): Node[] {
  invariant(
    raw !== null && typeof raw === 'object' && !Array.isArray(raw),
    'UNSUPPORTED_CONTRACT',
    'Expected a concrete contract object.',
  );
  const node = raw as Node;
  if (typeof node.$ref === 'string') {
    invariant(
      node.$ref.startsWith('#/$defs/') &&
        Object.keys(node).every((k) =>
          ['$ref', 'title', 'description'].includes(k),
        ),
      'UNSUPPORTED_CONTRACT',
      'Only local references are supported.',
    );
    const key = node.$ref.slice(8).replaceAll('~1', '/').replaceAll('~0', '~');
    invariant(
      !key.includes('/') && defs[key],
      'UNSUPPORTED_CONTRACT',
      'Unresolved contract definition.',
    );
    return leaves(defs[key], defs);
  }
  const union = node.anyOf ?? node.oneOf;
  if (union !== undefined) {
    invariant(
      Array.isArray(union) &&
        Object.keys(node).every((k) =>
          [
            '$schema',
            'type',
            'anyOf',
            'oneOf',
            '$defs',
            'title',
            'description',
          ].includes(k),
        ),
      'UNSUPPORTED_CONTRACT',
      'Unknown union wrapper is not weakened.',
    );
    return union.flatMap((x) => leaves(x, defs));
  }
  invariant(
    node.type === 'object' &&
      node.additionalProperties === false &&
      node.properties,
    'UNSUPPORTED_CONTRACT',
    'Expected a strict tool input leaf.',
  );
  return [{ ...node, $defs: defs }];
}
export function v2Component(name: string): z.ZodType {
  let compiled = cache.get(name);
  if (compiled) return compiled;
  const source = (snapshot.schemas as Record<string, unknown>)[name];
  invariant(
    source,
    'CONTRACT_NOT_AVAILABLE',
    'Required deployed component is unavailable.',
  );
  compiled = z.fromJSONSchema(source as Parameters<typeof z.fromJSONSchema>[0]);
  cache.set(name, compiled);
  return compiled;
}
export function validateV2Tool(
  name: string,
  value: Record<string, unknown>,
): void {
  const source = (snapshot.tools as Record<string, Node>)[name];
  invariant(
    source && typeof value.op === 'string',
    'INVALID_TOOL_INPUT',
    'Tool and explicit op must exist in the deployed contract.',
  );
  const key = `${name}/${value.op}`;
  let compiled = cache.get(key);
  if (!compiled) {
    const selected = leaves(source, (source.$defs ?? {}) as Node).filter(
      (node) => {
        const op = (node.properties as Node).op as Node | undefined;
        return (
          op?.const === value.op ||
          (Array.isArray(op?.enum) && op.enum.includes(value.op))
        );
      },
    );
    invariant(
      selected.length > 0,
      'INVALID_TOOL_OP',
      'Unknown deployed tool operation.',
    );
    const validators = selected.map((node) =>
      z.fromJSONSchema(node as Parameters<typeof z.fromJSONSchema>[0]),
    );
    compiled =
      validators.length === 1
        ? validators[0]!
        : z.union(validators as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    cache.set(key, compiled);
  }
  compiled.parse(value); // Validation only: do not submit a stripped/transformed parse result.
}
export function readV2<T>(name: string, value: unknown): T {
  v2Component(`ui-delivery.${name}`).parse(value);
  return structuredClone(value) as T;
}
export const v2ContractArtifactId = snapshot.artifactId;
export interface Descriptor {
  descriptorId: string;
  core: Omit<ResultItem, 'evidenceRefs'>;
  expectedRefCount: number;
  segmentCount: number;
  fullRefsDigest: string;
  itemDigest: string;
}
export interface RefSegment {
  descriptorId: string;
  segmentIndex: number;
  startIndex: number;
  evidenceRefs: string[];
}
export interface ExplicitNotExecuted {
  runItemId: string;
  localResultId: string;
  reason: string;
  endedAt?: string | undefined;
}
export interface ResultBatch {
  schemaVersion: 'ath.result-batch.v2';
  runId: string;
  batchId: string;
  snapshotDigest: string;
  items: ResultItem[];
  evidenceManifest: ManifestItem[];
  explicitNotExecutedItems: ExplicitNotExecuted[];
  descriptors: Descriptor[];
  evidenceSegments: RefSegment[];
}
export interface BatchItemReceipt {
  objectId: string;
  kind: 'result' | 'notExecuted' | 'descriptor' | 'segment';
  runItemId: string | null;
  status: 'accepted' | 'skipped' | 'conflict' | 'rejected' | 'pendingAssembly';
  resultId: string | null;
  revisionId: string | null;
  descriptorId: string | null;
  code: string | null;
}
export interface BatchReceipt {
  batchId: string;
  runId: string;
  snapshotDigest: string;
  semanticDigest: string;
  resultsAccepted: number;
  ledgerVersion: string;
  ledgerDigest: string;
  deliveryStatus: string;
  missingFilesScope: 'batch';
  missingFileIds: string[];
  reportId: string | null;
  perItemResults: BatchItemReceipt[];
  executionStateChanged: false;
}
export interface ExecutionFact {
  id: string;
  runId: string;
  sequence: string;
  kind: 'end' | 'resume';
  commandId: string | null;
  previousFactId: string | null;
  endFactId: string | null;
  resumeFactId: string | null;
  endKind: 'normal' | 'terminated' | 'interrupted' | 'legacy' | null;
  endedAt: string | null;
  resumedAt: string | null;
  reason: string;
  provenance: string;
  legacyState: string | null;
  receivedAt: string;
}
export interface DeliveryStatus {
  protocolVersion: 'ath.ui-delivery.v2';
  runId: string;
  projectId: string;
  snapshotDigest: string;
  mode: 'nativeV2' | 'legacyDeliveryOnly' | 'legacyResumed' | null;
  rowVersion: number;
  headRowVersion: number | null;
  executionState: string;
  executionProvenance: string;
  endedAt: string | null;
  reportId: string | null;
  progressSequence: string;
  completedItems: number;
  progressClosedAt: string | null;
  lastProgressAt: string | null;
  ledgerVersion: string;
  ledgerDigest: string;
  batchCount: number;
  totalItems: number;
  reportedItems: number;
  notReportedItems: number;
  pendingDescriptors: number;
  missingFileCount: number;
  lastFact: ExecutionFact | null;
  lastEndFact: ExecutionFact | null;
  lastResumeFact: ExecutionFact | null;
  latestSeal: {
    id: string;
    runId: string;
    commandId: string;
    ledgerVersion: string;
    ledgerDigest: string;
    coverageDigest: string;
    coverageCount: number;
    endFactId: string;
    createdAt: string;
  } | null;
  deliveryStatus: string;
  page: {
    kind: 'items' | 'files' | 'batches' | 'descriptors' | 'facts';
    items: Record<string, unknown>[];
    hasMore: boolean;
    nextCursor: string | null;
  };
}
