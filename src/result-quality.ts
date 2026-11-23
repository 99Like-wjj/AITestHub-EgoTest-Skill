import { invariant } from './errors.js';
import type { ResultItem, ScopeItem } from './contracts.js';
import type { EvidenceState } from './store.js';

export function validateRecordedResultQuality(
  item: ResultItem,
  fixed: ScopeItem,
  observedEvidence: ReadonlySet<string>,
  evidence: ReadonlyMap<string, EvidenceState>,
) {
  if (item.originalOutcome === 'notExecuted') return;
  const assertions = fixed.content.assertions ?? [];
  if (assertions.length === 0) {
    if (item.originalOutcome === 'passed' || item.originalOutcome === 'failed')
      invariant(
        item.evidenceRefs.some((id) => {
          const record = evidence.get(id);
          return record && record.captureCompleteness !== 'missing';
        }) || item.evidenceGaps?.length,
        'EVIDENCE_OR_GAP_REQUIRED',
        'A conclusive result needs actual evidence or an explicit gap for a case without formal assertions.',
      );
    return;
  }
  const checks = item.assertionResults ?? [];
  invariant(
    checks.length === assertions.length,
    'ASSERTION_RESULTS_INCOMPLETE',
    'Report a status for every frozen assertion, including those not confirmed.',
  );
  const supported = new Set<string>();
  for (const observation of item.observations ?? []) {
    const hasOriginal = observation.evidenceRefs?.some((id) => {
      const record = evidence.get(id);
      return (
        observedEvidence.has(id) &&
        record?.source === 'original' &&
        record.captureCompleteness !== 'missing' &&
        record.captureCompleteness !== 'summary'
      );
    });
    if (hasOriginal)
      for (const id of observation.assertionIds ?? []) supported.add(id);
  }
  invariant(
    checks.every(
      ({ assertionId, outcome }) =>
        (outcome !== 'passed' && outcome !== 'failed') ||
        supported.has(assertionId),
    ),
    'ASSERTION_EVIDENCE_REQUIRED',
    'Connect every conclusive assertion to an observed fact and its indexed original evidence.',
  );
  invariant(
    item.originalOutcome !== 'passed' ||
      checks.every(({ outcome }) => outcome === 'passed'),
    'OUTCOME_WITH_UNVERIFIED_ASSERTIONS',
    'A passing result needs every frozen assertion to be verified.',
  );
  invariant(
    item.originalOutcome !== 'failed' ||
      checks.some(({ outcome }) => outcome === 'failed'),
    'OUTCOME_WITHOUT_FAILED_ASSERTION',
    'A failing result needs at least one confirmed failing assertion.',
  );
}
