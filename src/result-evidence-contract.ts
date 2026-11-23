import overlay from '../contracts/step-evidence-v1.json' with { type: 'json' };
import qualityOverlay from '../contracts/result-quality-v1.json' with { type: 'json' };
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
export const resultQualityContract = {
  schemaVersion: qualityOverlay.schemaVersion,
  ...qualityOverlay.source,
};

function addProperties(
  schema: unknown,
  expected: number,
  matches: (properties: Node) => boolean,
  extensions: Node,
): unknown {
  if (expected === 0) return schema;
  const copy = structuredClone(schema);
  let count = 0;
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
      typeof node.properties === 'object' &&
      matches(node.properties as Node)
    ) {
      node.properties = { ...node.properties, ...extensions };
      count++;
      return;
    }
    for (const child of Object.values(node)) visit(child);
  }
  visit(copy);
  invariant(
    count === expected,
    'RESULT_CONTRACT_MISMATCH',
    'Reviewed result extensions do not match the preserved contract.',
  );
  return copy;
}

const frozenUiCaseProperties = [
  'kind',
  'scenarioId',
  'title',
  'testPoint',
  'preconditions',
  'steps',
  'expected',
  'basisRefs',
];

export function withCaseAssertions(schema: unknown): unknown {
  return addProperties(
    schema,
    1,
    (properties) =>
      typeof properties.kind === 'object' &&
      properties.kind !== null &&
      (properties.kind as Node).const === 'UI' &&
      Object.keys(properties).length === frozenUiCaseProperties.length &&
      frozenUiCaseProperties.every((field) => field in properties),
    qualityOverlay.properties.case,
  );
}

// Augment only the exact result leaf or its descriptor core. Frozen artifacts
// remain unchanged, including strict unknown-property rejection everywhere else.
export function withResultEvidence(
  schema: unknown,
  expected: number,
  identity: 'runItemId' | 'localItemId' = 'runItemId',
): unknown {
  return addProperties(
    schema,
    expected,
    (properties) =>
      legacyFields.every(
        (key) => (key === 'runItemId' ? identity : key) in properties,
      ) &&
      Object.keys(properties).length ===
        legacyFields.length + Number('evidenceRefs' in properties),
    { ...overlay.properties, ...qualityOverlay.properties.result },
  );
}

export function resultEvidenceToolLeaves(name: string, op: string) {
  if (name !== 'ath_results') return 0;
  if (op === 'prepare-ui-batch' || op === 'receive-ui-batch') return 2;
  return ['prepare', 'commit', 'explicit-amendment'].includes(op) ? 1 : 0;
}
