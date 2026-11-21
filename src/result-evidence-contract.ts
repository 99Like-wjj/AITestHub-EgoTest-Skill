import overlay from '../contracts/step-evidence-v1.json' with { type: 'json' };
import { invariant } from './errors.js';

type Node = Record<string, unknown>;
const legacyFields = [
  'runItemId',
  'localResultId',
  'originalOutcome',
  'actualObservations',
  'actualActions',
  'reason',
  'basis',
  'sideEffectCertainty',
  'startedAt',
  'endedAt',
] as const;

export const stepEvidenceContract = {
  schemaVersion: overlay.schemaVersion,
  ...overlay.source,
};

// Augment only the exact result leaf or its descriptor core. Frozen artifacts
// remain unchanged, including strict unknown-property rejection everywhere else.
export function withResultEvidence(schema: unknown, expected: number): unknown {
  if (expected === 0) return schema;
  const copy = structuredClone(schema);
  let matches = 0;
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Node;
    if (
      node.type === 'object' &&
      node.additionalProperties === false &&
      node.properties !== null &&
      typeof node.properties === 'object'
    ) {
      const keys = Object.keys(node.properties);
      if (
        legacyFields.every((key) => keys.includes(key)) &&
        keys.length ===
          legacyFields.length + Number(keys.includes('evidenceRefs'))
      ) {
        node.properties = { ...node.properties, ...overlay.properties };
        matches++;
        return;
      }
    }
    for (const child of Object.values(node)) visit(child);
  }
  visit(copy);
  invariant(
    matches === expected,
    'STEP_EVIDENCE_CONTRACT_MISMATCH',
    'The frozen result contract no longer matches the reviewed step evidence extension.',
  );
  return copy;
}

export function resultEvidenceToolLeaves(name: string, op: string) {
  if (name !== 'ath_results') return 0;
  if (op === 'prepare-ui-batch' || op === 'receive-ui-batch') return 2;
  return ['prepare', 'commit', 'explicit-amendment'].includes(op) ? 1 : 0;
}
