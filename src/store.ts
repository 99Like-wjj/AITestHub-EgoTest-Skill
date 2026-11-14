import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonical,
  digest,
  parseJson,
  assertNoSecrets,
  bytesHash,
} from './canonical.js';
import { invariant, LocalError } from './errors.js';
import {
  scope,
  identitySchema,
  id,
  localId,
  sha,
  bytes,
  time,
  resultSchema,
} from './contracts.js';
import type {
  ExecutionScope,
  Identity,
  ResultItem,
  Submission,
  Receipt,
} from './contracts.js';
import type { WorkspacePort } from './ports.js';

const zero = '0'.repeat(64);
function ledgerJson(value: unknown) {
  const text = canonical(value);
  invariant(
    Buffer.byteLength(text, 'utf8') <= 16 * 1024 * 1024,
    'LOCAL_LEDGER_LIMIT',
    'Local record exceeds the safe JSON limit; existing bytes were preserved.',
  );
  return text;
}
const localEvidenceSchema = z.strictObject({
  localEvidenceId: localId,
  relativePath: z.string().min(1).max(1000),
  originalName: z.string().min(1).max(512),
  mediaType: z.string().min(1).max(256),
  sha256: sha,
  bytes,
  type: z.enum([
    'screenshot',
    'requestResponse',
    'conversation',
    'log',
    'attachment',
    'other',
  ]),
  captureCompleteness: z.enum([
    'full',
    'viewport',
    'partial',
    'summary',
    'interrupted',
    'missing',
  ]),
  source: z.enum(['original', 'derived', 'manualAddition']),
  capturedAt: time.optional(),
});
export type LocalEvidence = z.infer<typeof localEvidenceSchema>;
const observationSchema = z.strictObject({
  observationId: id,
  runItemId: id,
  summary: z.string().min(1).max(100000),
  evidenceIds: z.array(localId).max(1000),
  phase: z.enum(['before', 'after', 'reconciliation']),
  observedAt: time,
});
export type Observation = z.infer<typeof observationSchema>;
const actionSchema = z.strictObject({
  actionId: id,
  runItemId: id,
  summary: z.string().min(1).max(10000),
  sideEffect: z.enum(['none', 'possible']),
});
export type Action = z.infer<typeof actionSchema>;
export interface ActionState extends Action {
  status: 'intent' | 'dispatched' | 'observed' | 'unknown' | 'notOccurred';
  attempted: boolean;
  reason?: string | undefined;
}
export type Outbox = {
  outboxId: string;
  kind: 'progress' | 'result';
  tool: 'ath_ui_executions' | 'ath_results';
  args: Record<string, unknown>;
  payloadDigest: string;
  status: 'prepared' | 'dispatched' | 'unknown' | 'acknowledged' | 'rejected';
  receipt?: unknown;
  lastRecovery?: unknown;
  replayReason?: string | undefined;
  transportArgs?: Record<string, unknown>;
  transportDigest?: string;
};
export type EvidenceState = LocalEvidence & {
  upload: 'local' | 'uploading' | 'registered' | 'verified' | 'unknown';
  fileId?: string | undefined;
  localFileId?: string | undefined;
  lastRecovery?: unknown;
};
export type LocalResult = {
  item: ResultItem;
  observationIds: string[];
  evidenceGap?: { reason: string; impact: string } | undefined;
  unresolvedActionIds: string[];
};
export interface View {
  identity: Identity;
  scope: ExecutionScope;
  sequence: number;
  observations: Map<string, Observation>;
  actions: Map<string, ActionState>;
  evidence: Map<string, EvidenceState>;
  results: Map<string, LocalResult>;
  outboxes: Map<string, Outbox>;
}
/** Unexecuted is a factual declaration, never an escape hatch for unknown effects. */
export function assertCanDeclareNotExecuted(
  view: View,
  runItemId: string,
): void {
  const attempted = [...view.actions.values()].some(
    (x) =>
      x.runItemId === runItemId && (x.attempted || x.status !== 'notOccurred'),
  );
  const observed = [...view.observations.values()].some(
    (x) => x.runItemId === runItemId && x.phase === 'after',
  );
  const recorded = view.results.get(runItemId);
  invariant(
    !attempted &&
      !observed &&
      (!recorded || recorded.item.originalOutcome === 'notExecuted'),
    'NOT_EXECUTED_CONFLICT',
    'This item has attempted, observed or unresolved execution facts. Reconcile read-only and retain the real outcome; do not conceal it as not executed.',
  );
}
interface StateFile {
  format: 'ath.web-execute.local.v1';
  identity: Identity;
  scope: ExecutionScope;
  freezeDigest: string;
  head: { sequence: number; hash: string };
}
interface Event {
  format: 'ath.web-execute.event.v1';
  sequence: number;
  previousHash: string;
  eventId: string;
  occurredAt: string;
  type: string;
  data: unknown;
  hash: string;
}
const stateSchema = z.strictObject({
  format: z.literal('ath.web-execute.local.v1'),
  identity: identitySchema,
  scope: z.unknown(),
  freezeDigest: sha,
  head: z.strictObject({ sequence: z.number().int().min(0), hash: sha }),
});
const eventSchema = z.strictObject({
  format: z.literal('ath.web-execute.event.v1'),
  sequence: z.number().int().min(1),
  previousHash: sha,
  eventId: id,
  occurredAt: time,
  type: z.string(),
  data: z.unknown(),
  hash: sha,
});
export function safeRelativeEvidence(path: string): string {
  invariant(
    /^evidence\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) &&
      !path
        .split('/')
        .some(
          (x) =>
            !x ||
            x === '.' ||
            x === '..' ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x) ||
            x.endsWith('.'),
        ),
    'UNSAFE_PATH',
    'Use an owned relative evidence path without traversal, drive or reserved segments.',
  );
  return path;
}
export class ExecutionStore {
  readonly prefix: string;
  constructor(
    readonly workspace: WorkspacePort,
    readonly runId: string,
  ) {
    id.parse(runId);
    this.prefix = `runs/${runId}`;
  }
  private key(name: string) {
    return `${this.prefix}/${name}`;
  }
  private eventKey(seq: number) {
    return this.key(`events/${String(seq).padStart(10, '0')}.json`);
  }
  static async freeze(
    workspace: WorkspacePort,
    identity: Identity,
    raw: unknown,
  ): Promise<ExecutionStore> {
    const fixed = scope(raw),
      who = identitySchema.parse(identity),
      store = new ExecutionStore(workspace, fixed.runId),
      freezeDigest = digest({ identity: who, scope: fixed });
    await workspace.withExclusive(store.key('mutation'), async () => {
      const existing = await workspace.readText(store.key('state.json'));
      if (existing !== null) {
        const state = store.parseState(existing);
        invariant(
          state.freezeDigest === freezeDigest,
          'RUN_ID_CONFLICT',
          'This run is already frozen with another identity or scope.',
        );
        await store.readInternal(state);
        return;
      }
      const state: StateFile = {
        format: 'ath.web-execute.local.v1',
        identity: who,
        scope: fixed,
        freezeDigest,
        head: { sequence: 0, hash: zero },
      };
      await workspace.writeTextAtomic(
        store.key('state.json'),
        ledgerJson(state),
      );
    });
    return store;
  }
  private parseState(text: string): StateFile {
    try {
      const x = stateSchema.parse(parseJson(text)),
        fixed = scope(x.scope);
      invariant(
        fixed.runId === this.runId &&
          digest({ identity: x.identity, scope: fixed }) === x.freezeDigest,
        'CORRUPT_LEDGER',
        'Frozen identity or scope changed.',
      );
      return { ...x, scope: fixed };
    } catch (error) {
      if (error instanceof LocalError) throw error;
      throw new LocalError(
        'CORRUPT_LEDGER',
        'Run state is damaged; preserved without overwrite.',
      );
    }
  }
  private async state(): Promise<StateFile> {
    const text = await this.workspace.readText(this.key('state.json'));
    invariant(text !== null, 'RUN_NOT_FOUND', 'No frozen local run exists.');
    return this.parseState(text);
  }
  private apply(view: View, event: Event) {
    const data = event.data;
    switch (event.type) {
      case 'observation': {
        const x = observationSchema.parse(data);
        view.observations.set(x.observationId, x);
        break;
      }
      case 'action-intent': {
        const x = actionSchema.parse(data);
        view.actions.set(x.actionId, {
          ...x,
          status: 'intent',
          attempted: false,
        });
        break;
      }
      case 'action-status': {
        const x = z
            .strictObject({
              actionId: id,
              status: z.enum([
                'dispatched',
                'observed',
                'unknown',
                'notOccurred',
              ]),
              reason: z.string().max(10000).optional(),
            })
            .parse(data),
          a = view.actions.get(x.actionId);
        invariant(a, 'CORRUPT_LEDGER', 'Action update has no original intent.');
        view.actions.set(x.actionId, {
          ...a,
          ...x,
          attempted:
            a.attempted || x.status === 'dispatched' || x.status === 'observed',
        });
        break;
      }
      case 'evidence': {
        const x = localEvidenceSchema.parse(data);
        safeRelativeEvidence(x.relativePath);
        view.evidence.set(x.localEvidenceId, { ...x, upload: 'local' });
        break;
      }
      case 'file-status': {
        const x = z
            .strictObject({
              localEvidenceId: localId,
              upload: z.enum([
                'uploading',
                'registered',
                'verified',
                'unknown',
              ]),
              fileId: id.optional(),
              localFileId: localId.optional(),
            })
            .parse(data),
          e = view.evidence.get(x.localEvidenceId);
        invariant(e, 'CORRUPT_LEDGER', 'File update has no evidence identity.');
        view.evidence.set(x.localEvidenceId, { ...e, ...x });
        break;
      }
      case 'file-recovery': {
        const x = z
            .strictObject({ localEvidenceId: localId, value: z.unknown() })
            .parse(data),
          e = view.evidence.get(x.localEvidenceId);
        invariant(e, 'CORRUPT_LEDGER', 'Recovery has no evidence identity.');
        view.evidence.set(x.localEvidenceId, { ...e, lastRecovery: x.value });
        break;
      }
      case 'result': {
        const x = z
          .strictObject({
            item: resultSchema,
            observationIds: z.array(id),
            unresolvedActionIds: z.array(id),
            evidenceGap: z
              .strictObject({
                reason: z.string().min(1),
                impact: z.string().min(1),
              })
              .optional(),
          })
          .parse(data);
        view.results.set(x.item.runItemId, x);
        break;
      }
      case 'outbox': {
        const x = z
          .strictObject({
            outboxId: id,
            kind: z.enum(['progress', 'result']),
            tool: z.enum(['ath_ui_executions', 'ath_results']),
            args: z.record(z.string(), z.unknown()),
            payloadDigest: sha,
          })
          .parse(data);
        invariant(
          digest(x.args) === x.payloadDigest,
          'CORRUPT_LEDGER',
          'Frozen outbox digest changed.',
        );
        view.outboxes.set(x.outboxId, { ...x, status: 'prepared' });
        break;
      }
      case 'outbox-status': {
        const x = z
            .strictObject({
              outboxId: id,
              status: z.enum([
                'dispatched',
                'unknown',
                'acknowledged',
                'rejected',
              ]),
              receipt: z.unknown().optional(),
              replayReason: z.string().min(1).optional(),
            })
            .parse(data),
          o = view.outboxes.get(x.outboxId);
        invariant(
          o,
          'CORRUPT_LEDGER',
          'Outbox status has no original payload.',
        );
        view.outboxes.set(x.outboxId, { ...o, ...x });
        break;
      }
      case 'outbox-recovery': {
        const x = z
            .strictObject({ outboxId: id, value: z.unknown() })
            .parse(data),
          o = view.outboxes.get(x.outboxId);
        invariant(o, 'CORRUPT_LEDGER', 'Recovery has no original outbox.');
        view.outboxes.set(x.outboxId, { ...o, lastRecovery: x.value });
        break;
      }
      case 'result-transport': {
        const x = z
            .strictObject({
              outboxId: id,
              args: z.record(z.string(), z.unknown()),
              transportDigest: sha,
            })
            .parse(data),
          o = view.outboxes.get(x.outboxId);
        invariant(
          o && digest(x.args) === x.transportDigest,
          'CORRUPT_LEDGER',
          'Original JSON transport has no matching frozen outbox.',
        );
        view.outboxes.set(x.outboxId, {
          ...o,
          transportArgs: x.args,
          transportDigest: x.transportDigest,
        });
        break;
      }
      default:
        throw new LocalError(
          'UNSUPPORTED_LEDGER_EVENT',
          'Unknown journal event; no record was overwritten.',
        );
    }
    view.sequence = event.sequence;
  }
  private async readInternal(state: StateFile): Promise<View> {
    const view: View = {
      identity: state.identity,
      scope: state.scope,
      sequence: 0,
      observations: new Map(),
      actions: new Map(),
      evidence: new Map(),
      results: new Map(),
      outboxes: new Map(),
    };
    let previous = zero;
    try {
      for (let sequence = 1; sequence <= state.head.sequence; sequence++) {
        const text = await this.workspace.readText(this.eventKey(sequence));
        invariant(text !== null, 'CORRUPT_LEDGER', 'Journal event is missing.');
        const e = eventSchema.parse(parseJson(text)) as Event,
          { hash, ...without } = e;
        invariant(
          e.sequence === sequence &&
            e.previousHash === previous &&
            digest(without) === hash,
          'CORRUPT_LEDGER',
          'Journal hash chain is damaged.',
        );
        this.apply(view, e);
        previous = hash;
      }
      invariant(
        previous === state.head.hash,
        'CORRUPT_LEDGER',
        'Journal head does not match the chain.',
      );
      invariant(
        (await this.workspace.readText(
          this.eventKey(state.head.sequence + 1),
        )) === null,
        'UNCOMMITTED_EVENT',
        'An uncommitted event is preserved; explicit recovery is required, not overwrite.',
      );
      return view;
    } catch (error) {
      if (error instanceof LocalError) throw error;
      throw new LocalError(
        'CORRUPT_LEDGER',
        'Journal data is damaged; no repair or overwrite was attempted.',
      );
    }
  }
  async read(): Promise<View> {
    return this.workspace.withExclusive(this.key('mutation'), async () =>
      this.readInternal(await this.state()),
    );
  }
  private async mutate<T>(
    work: (
      view: View,
      emit: (type: string, data: unknown) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.workspace.withExclusive(this.key('mutation'), async () => {
      const state = await this.state(),
        view = await this.readInternal(state);
      const emit = async (type: string, data: unknown) => {
        assertNoSecrets(data);
        canonical(data);
        const base = {
            format: 'ath.web-execute.event.v1' as const,
            sequence: state.head.sequence + 1,
            previousHash: state.head.hash,
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            type,
            data,
          },
          event: Event = { ...base, hash: digest(base) };
        invariant(
          (await this.workspace.readText(this.eventKey(event.sequence))) ===
            null,
          'UNCOMMITTED_EVENT',
          'A next event already exists; never overwrite it.',
        );
        this.apply(view, event);
        await this.workspace.writeTextAtomic(
          this.eventKey(event.sequence),
          ledgerJson(event),
        );
        state.head = { sequence: event.sequence, hash: event.hash };
        await this.workspace.writeTextAtomic(
          this.key('state.json'),
          ledgerJson(state),
        );
      };
      return work(view, emit);
    });
  }
  private fixed(view: View, runItemId: string) {
    invariant(
      view.scope.items.some((x) => x.runItemId === runItemId),
      'OUTSIDE_SCOPE',
      'The item is not in this frozen scope.',
    );
  }
  async beginAction(input: Omit<Action, 'actionId'>): Promise<string> {
    const x = actionSchema.parse({ ...input, actionId: randomUUID() });
    return this.mutate(async (v, emit) => {
      this.fixed(v, x.runItemId);
      invariant(
        ![...v.actions.values()].some((a) =>
          ['intent', 'dispatched'].includes(a.status),
        ),
        'SERIAL_ACTION_REQUIRED',
        'Record or reconcile the current in-flight action before beginning another.',
      );
      invariant(
        !v.results.has(x.runItemId),
        'RESULT_FROZEN',
        'This Case already has a recorded result; do not silently repeat SUT actions.',
      );
      invariant(
        ![...v.actions.values()].some(
          (a) =>
            a.runItemId === x.runItemId &&
            ['intent', 'dispatched', 'unknown'].includes(a.status),
        ),
        'ACTION_RECONCILIATION_REQUIRED',
        'An earlier action needs reconciliation before another action for this Case.',
      );
      await emit('action-intent', x);
      return x.actionId;
    });
  }
  async actionStatus(
    actionId: string,
    status: 'dispatched' | 'observed' | 'unknown' | 'notOccurred',
    reason?: string,
  ) {
    return this.mutate(async (v, emit) => {
      const action = v.actions.get(actionId);
      invariant(action, 'ACTION_NOT_FOUND', 'No such action intent.');
      if (status === 'dispatched')
        invariant(
          action.status === 'intent',
          'ACTION_REPLAY_FORBIDDEN',
          'A dispatched or unknown SUT action is never replayed by this tool.',
        );
      else
        invariant(
          reason?.trim(),
          'RECONCILIATION_REASON_REQUIRED',
          'Record the real observation/reconciliation reason.',
        );
      await emit('action-status', {
        actionId,
        status,
        ...(reason === undefined ? {} : { reason }),
      });
    });
  }
  async observe(
    input: Omit<Observation, 'observationId' | 'observedAt'> & {
      observedAt?: string;
    },
  ): Promise<string> {
    const x = observationSchema.parse({
      ...input,
      observationId: randomUUID(),
      observedAt: input.observedAt ?? new Date().toISOString(),
    });
    return this.mutate(async (v, emit) => {
      this.fixed(v, x.runItemId);
      for (const e of x.evidenceIds)
        invariant(
          v.evidence.has(e),
          'EVIDENCE_NOT_FOUND',
          'Observation evidence is not indexed.',
        );
      await emit('observation', x);
      return x.observationId;
    });
  }
  async indexEvidence(input: LocalEvidence) {
    const x = localEvidenceSchema.parse(input);
    safeRelativeEvidence(x.relativePath);
    invariant(
      !/[\/\\\x00-\x1f\x7f]/.test(x.originalName),
      'UNSAFE_PATH',
      'Evidence name must be a basename.',
    );
    return this.mutate(async (v, emit) => {
      const existing = v.evidence.get(x.localEvidenceId);
      if (existing) {
        const {
          upload: _upload,
          fileId: _fileId,
          localFileId: _localId,
          lastRecovery: _lastRecovery,
          ...prior
        } = existing;
        invariant(
          digest(prior) === digest(x),
          'EVIDENCE_ID_CONFLICT',
          'Original evidence identity cannot be rebound.',
        );
        return;
      }
      await emit('evidence', x);
    });
  }
  async fileStatus(
    localEvidenceId: string,
    upload: 'uploading' | 'registered' | 'verified' | 'unknown',
    metadata?: {
      fileId: string;
      localFileId: string;
      bytes: string;
      sha256: string;
    },
  ) {
    return this.mutate(async (v, emit) => {
      const e = v.evidence.get(localEvidenceId);
      invariant(e, 'EVIDENCE_NOT_FOUND', 'No such evidence.');
      if (metadata) {
        invariant(
          e.bytes === metadata.bytes && e.sha256 === metadata.sha256,
          'FILE_DIGEST_MISMATCH',
          'File receipt does not match the original indexed bytes.',
        );
        invariant(
          !e.fileId || e.fileId === metadata.fileId,
          'FILE_ID_CONFLICT',
          'Registered file identity changed.',
        );
        id.parse(metadata.fileId);
        localId.parse(metadata.localFileId);
      }
      invariant(
        upload !== 'verified' || metadata,
        'UNVERIFIED_FILE',
        'Verified status requires a real matching file receipt.',
      );
      await emit('file-status', {
        localEvidenceId,
        upload,
        ...(metadata
          ? { fileId: metadata.fileId, localFileId: metadata.localFileId }
          : {}),
      });
    });
  }
  async recordResult(input: LocalResult) {
    const x = z
      .strictObject({
        item: resultSchema,
        observationIds: z.array(id),
        unresolvedActionIds: z.array(id),
        evidenceGap: z
          .strictObject({
            reason: z.string().min(1).max(10000),
            impact: z.string().min(1).max(10000),
          })
          .optional(),
      })
      .parse(input);
    return this.mutate(async (v, emit) => {
      this.fixed(v, x.item.runItemId);
      if (x.item.originalOutcome === 'notExecuted') {
        assertCanDeclareNotExecuted(v, x.item.runItemId);
        invariant(
          x.item.sideEffectCertainty === 'notApplicable',
          'NOT_EXECUTED_CONFLICT',
          'An unexecuted item cannot claim unknown/known side effects.',
        );
      }
      const old = v.results.get(x.item.runItemId);
      if (old) {
        invariant(
          digest(old) === digest(x),
          'EXPLICIT_AMENDMENT_REQUIRED',
          'Original local result is immutable; an explicit correction workflow is required.',
        );
        return;
      }
      invariant(
        ![...v.results.values()].some(
          (r) => r.item.localResultId === x.item.localResultId,
        ),
        'RESULT_ID_CONFLICT',
        'Local result ID already belongs to another item.',
      );
      invariant(
        x.item.originalOutcome === 'notExecuted' || x.observationIds.length > 0,
        'OBSERVATION_REQUIRED',
        'Actual execution needs a real observation record.',
      );
      for (const o of x.observationIds) {
        const obs = v.observations.get(o);
        invariant(
          obs?.runItemId === x.item.runItemId,
          'OBSERVATION_SCOPE_MISMATCH',
          'Observation belongs to another item or is missing.',
        );
        invariant(
          obs.evidenceIds.every((e) => x.item.evidenceRefs.includes(e)),
          'EVIDENCE_OMITTED',
          'Result must retain evidence from its referenced observations.',
        );
      }
      for (const e of x.item.evidenceRefs)
        invariant(
          v.evidence.has(e),
          'EVIDENCE_NOT_FOUND',
          'Result evidence is not indexed.',
        );
      const unresolved = [...v.actions.values()]
        .filter(
          (a) =>
            a.runItemId === x.item.runItemId &&
            ['intent', 'dispatched', 'unknown'].includes(a.status),
        )
        .map((a) => a.actionId)
        .sort();
      invariant(
        canonical([...x.unresolvedActionIds].sort()) === canonical(unresolved),
        'UNRESOLVED_ACTION_OMITTED',
        'Unresolved actions must be declared, not hidden.',
      );
      if (unresolved.length)
        invariant(
          x.item.sideEffectCertainty === 'unknown',
          'UNKNOWN_EFFECT_OMITTED',
          'Unresolved actions require unknown side-effect certainty.',
        );
      if (
        ['passed', 'failed'].includes(x.item.originalOutcome) &&
        !x.item.evidenceRefs.some(
          (e) => v.evidence.get(e)?.type === 'screenshot',
        )
      )
        invariant(
          x.evidenceGap,
          'SCREENSHOT_OR_GAP_REQUIRED',
          'Record a real key screenshot or an explicit evidence gap and its impact.',
        );
      await emit('result', x);
    });
  }
  async recoveredFile(localEvidenceId: string, value: unknown) {
    return this.mutate(async (v, emit) => {
      invariant(
        v.evidence.has(localEvidenceId),
        'EVIDENCE_NOT_FOUND',
        'No such evidence.',
      );
      await emit('file-recovery', { localEvidenceId, value });
    });
  }
  async attachResultJson(outboxId: string, localEvidenceId: string) {
    return this.mutate(async (v, emit) => {
      const o = v.outboxes.get(outboxId),
        e = v.evidence.get(localEvidenceId);
      invariant(
        o?.kind === 'result' && o.status === 'prepared',
        'OUTBOX_STATE',
        'Select a verified JSON transport before dispatching the original submission.',
      );
      invariant(
        e?.upload === 'verified' && e.fileId,
        'FILE_NOT_VERIFIED',
        'Original JSON must have a verified matching upload.',
      );
      const encoded = canonical(o.args.input);
      invariant(
        e.sha256 === bytesHash(Buffer.from(encoded, 'utf8')) &&
          e.bytes === String(Buffer.byteLength(encoded, 'utf8')),
        'ORIGINAL_JSON_MISMATCH',
        'JSON file differs from the exact frozen submission.',
      );
      const args = {
          op: 'submit-file',
          projectId: v.scope.projectId,
          fileId: e.fileId,
        },
        transportDigest = digest(args);
      if (o.transportArgs) {
        invariant(
          o.transportDigest === transportDigest,
          'OUTBOX_ID_CONFLICT',
          'Original transport is already fixed to another file.',
        );
        return;
      }
      const payload = o.args.input as Submission,
        files = new Map(
          payload.evidenceManifest.map((x) => [x.fileId, BigInt(x.bytes)]),
        );
      files.set(e.fileId, BigInt(e.bytes));
      invariant(
        [...files.values()].reduce((a, b) => a + b, 0n) <= 1073741824n,
        'DELIVERY_BYTE_LIMIT',
        'Original JSON source also counts toward the 1GiB unique-file budget.',
      );
      await emit('result-transport', { outboxId, args, transportDigest });
    });
  }
  async beginFileUpload(localEvidenceId: string, localFileId: string) {
    localId.parse(localFileId);
    return this.mutate(async (v, emit) => {
      const e = v.evidence.get(localEvidenceId);
      invariant(e, 'EVIDENCE_NOT_FOUND', 'No such evidence.');
      invariant(
        !e.localFileId || e.localFileId === localFileId,
        'FILE_ID_CONFLICT',
        'Original local file identity cannot change.',
      );
      await emit('file-status', {
        localEvidenceId,
        localFileId,
        upload: 'uploading',
      });
    });
  }
  async addOutbox(value: Omit<Outbox, 'status' | 'receipt' | 'lastRecovery'>) {
    return this.mutate(async (v, emit) => {
      invariant(
        !v.outboxes.has(value.outboxId),
        'OUTBOX_ID_CONFLICT',
        'Outbox identity already exists.',
      );
      invariant(
        digest(value.args) === value.payloadDigest,
        'OUTBOX_DIGEST_MISMATCH',
        'Outbox payload is not frozen.',
      );
      await emit('outbox', value);
    });
  }
  async outboxStatus(
    outboxId: string,
    status: Outbox['status'],
    receipt?: unknown,
    replayReason?: string,
  ) {
    invariant(
      status !== 'prepared',
      'OUTBOX_STATE',
      'Prepared is established only by the original frozen payload.',
    );
    return this.mutate(async (v, emit) => {
      const o = v.outboxes.get(outboxId);
      invariant(o, 'OUTBOX_NOT_FOUND', 'No original outbox exists.');
      if (status === 'dispatched')
        invariant(
          o.status === 'prepared' ||
            (['unknown', 'dispatched'].includes(o.status) &&
              o.lastRecovery !== undefined &&
              replayReason?.trim()),
          'OUTBOX_RECOVERY_REQUIRED',
          'Dispatched/unknown metadata needs original recovery and explicit same-payload replay, not another send.',
        );
      await emit('outbox-status', {
        outboxId,
        status,
        ...(receipt === undefined ? {} : { receipt }),
        ...(replayReason === undefined ? {} : { replayReason }),
      });
    });
  }
  async recovered(outboxId: string, value: unknown) {
    return this.mutate(async (v, emit) => {
      invariant(
        v.outboxes.has(outboxId),
        'OUTBOX_NOT_FOUND',
        'No original outbox exists.',
      );
      await emit('outbox-recovery', { outboxId, value });
    });
  }
  async acceptRecovered(outboxId: string, receipt: Receipt) {
    await this.outboxStatus(outboxId, 'acknowledged', receipt);
  }
}

export function resultPayload(view: View, submission: Submission): void {
  invariant(
    submission.runId === view.scope.runId &&
      submission.snapshotDigest === view.scope.snapshotDigest,
    'SCOPE_DIGEST_MISMATCH',
    'Submission is not for this fixed scope.',
  );
  const ids = [
    ...submission.items.map((x) => x.runItemId),
    ...submission.notExecutedItemIds,
  ];
  invariant(
    ids.every((x) => view.scope.items.some((y) => y.runItemId === x)),
    'OUTSIDE_SCOPE',
    'Submission contains an item outside this run.',
  );
  for (const runItemId of submission.notExecutedItemIds)
    assertCanDeclareNotExecuted(view, runItemId);
  for (const item of submission.items)
    if (item.originalOutcome === 'notExecuted') {
      assertCanDeclareNotExecuted(view, item.runItemId);
      invariant(
        item.sideEffectCertainty === 'notApplicable',
        'NOT_EXECUTED_CONFLICT',
        'An unexecuted item cannot claim unknown/known side effects.',
      );
    }
  if (submission.completion === 'complete')
    invariant(
      ids.length === view.scope.items.length,
      'SCOPE_INCOMPLETE',
      'Complete delivery must account for the full fixed scope; no automatic not-executed fill.',
    );
}
