import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, digest, parseJson, assertNoSecrets } from './canonical.js';
import { id, sha } from './contracts.js';
import type { ExecutionStore } from './store.js';
import { invariant } from './errors.js';
import { v2ContractArtifactId } from './v2-contracts.js';

export type V2Kind = 'batch' | 'end' | 'resume' | 'seal' | 'progress';
export interface V2Outbox {
  format: 'ath.web-execute.v2-outbox.v1';
  id: string;
  kind: V2Kind;
  tool: 'ath_results' | 'ath_ui_executions';
  args: Record<string, unknown>;
  payloadDigest: string;
  state: 'prepared' | 'dispatching' | 'unknown' | 'acknowledged' | 'rejected';
  receipt?: unknown;
  recovery?: unknown;
  failure?: { code: string; certainty: string } | undefined;
  transportArgs?: Record<string, unknown> | undefined;
  transportDigest?: string | undefined;
  sourceEvidenceId?: string | undefined;
  retryReason?: string | undefined;
}
interface Index {
  format: 'ath.web-execute.delivery.v2';
  contractArtifactId: string;
  freezeDigest: string;
  ids: string[];
  plans: {
    id: string;
    runItemIds: string[];
    selectionDigest: string;
    batchIds: string[];
  }[];
  preparing: string[] | null;
}
const indexSchema = z.strictObject({
  format: z.literal('ath.web-execute.delivery.v2'),
  contractArtifactId: z.literal(v2ContractArtifactId),
  freezeDigest: sha,
  ids: z.array(id).max(50000),
  plans: z
    .array(
      z.strictObject({
        id,
        runItemIds: z.array(id),
        selectionDigest: sha,
        batchIds: z.array(id),
      }),
    )
    .max(10000),
  preparing: z.array(id).nullable(),
});
const recordSchema = z.strictObject({
  format: z.literal('ath.web-execute.v2-outbox.v1'),
  id,
  kind: z.enum(['batch', 'end', 'resume', 'seal', 'progress']),
  tool: z.enum(['ath_results', 'ath_ui_executions']),
  args: z.record(z.string(), z.unknown()),
  payloadDigest: sha,
  state: z.enum([
    'prepared',
    'dispatching',
    'unknown',
    'acknowledged',
    'rejected',
  ]),
  receipt: z.unknown().optional(),
  recovery: z.unknown().optional(),
  failure: z
    .strictObject({ code: z.string().max(100), certainty: z.string().max(30) })
    .optional(),
  transportArgs: z.record(z.string(), z.unknown()).optional(),
  transportDigest: sha.optional(),
  sourceEvidenceId: z.string().optional(),
  retryReason: z.string().optional(),
});
function encoded(value: unknown) {
  assertNoSecrets(value);
  const body = canonical(value);
  invariant(
    Buffer.byteLength(body, 'utf8') <= 16777216,
    'LOCAL_DELIVERY_LIMIT',
    'A delivery record exceeds the safe local JSON limit; facts were retained.',
  );
  return body;
}

/** File-by-file frozen metadata transactions, distinct from the observation/action journal. */
export class V2DeliveryStore {
  readonly prefix: string;
  constructor(readonly facts: ExecutionStore) {
    this.prefix = `${facts.prefix}/delivery-v2`;
  }
  private key(name: string) {
    return `${this.prefix}/${name}`;
  }
  private async index(allowPreparing = false): Promise<Index> {
    const view = await this.facts.read(),
      expected = digest({ identity: view.identity, scope: view.scope });
    const raw = await this.facts.workspace.readText(this.key('index.json'));
    if (raw === null)
      return {
        format: 'ath.web-execute.delivery.v2',
        contractArtifactId: v2ContractArtifactId,
        freezeDigest: expected,
        ids: [],
        plans: [],
        preparing: null,
      };
    const wrapper = z
      .strictObject({ value: indexSchema, hash: sha })
      .parse(parseJson(raw));
    invariant(
      digest(wrapper.value) === wrapper.hash &&
        wrapper.value.freezeDigest === expected,
      'CORRUPT_DELIVERY',
      'Delivery index or scope identity changed.',
    );
    invariant(
      allowPreparing || wrapper.value.preparing === null,
      'LOCAL_PREPARE_INTERRUPTED',
      'A local multi-file preparation was interrupted. Preserve the original IDs/files; no remote write is permitted.',
    );
    return wrapper.value;
  }
  private async saveIndex(value: Index) {
    indexSchema.parse(value);
    await this.facts.workspace.writeTextAtomic(
      this.key('index.json'),
      encoded({ value, hash: digest(value) }),
    );
  }
  private async saveRecord(value: V2Outbox) {
    await this.facts.workspace.writeTextAtomic(
      this.key(`outboxes/${value.id}.json`),
      encoded({ value, hash: digest(value) }),
    );
  }
  private async record(recordId: string): Promise<V2Outbox> {
    id.parse(recordId);
    const text = await this.facts.workspace.readText(
      this.key(`outboxes/${recordId}.json`),
    );
    invariant(
      text !== null,
      'CORRUPT_DELIVERY',
      'An indexed original outbox file is missing.',
    );
    const raw = z
        .strictObject({ value: recordSchema, hash: sha })
        .parse(parseJson(text)),
      record = raw.value;
    invariant(
      record.id === recordId &&
        digest(record) === raw.hash &&
        digest(record.args) === record.payloadDigest,
      'CORRUPT_DELIVERY',
      'Original outbox identity or payload changed.',
    );
    if (record.transportArgs)
      invariant(
        record.transportDigest === digest(record.transportArgs),
        'CORRUPT_DELIVERY',
        'Frozen file-transport identity changed.',
      );
    return record;
  }
  async read() {
    const index = await this.index();
    return {
      index,
      records: await Promise.all(index.ids.map((x) => this.record(x))),
    };
  }
  async get(recordId: string) {
    const value = await this.read();
    invariant(
      value.index.ids.includes(recordId),
      'OUTBOX_NOT_FOUND',
      'No such original v2 outbox exists.',
    );
    return this.record(recordId);
  }
  async prepare(
    records: V2Outbox[],
    plan?: { runItemIds: string[]; selectionDigest: string },
  ) {
    return this.facts.workspace.withExclusive(
      this.key('mutation'),
      async () => {
        const index = await this.index();
        if (plan) {
          const existing = index.plans.find(
            (x) => x.selectionDigest === plan.selectionDigest,
          );
          if (existing) return existing;
          invariant(
            !index.plans.some((p) =>
              p.runItemIds.some((x) => plan.runItemIds.includes(x)),
            ),
            'DELIVERY_ALREADY_PLANNED',
            'Some original results already belong to a frozen delivery plan. Recover that plan, not a new batch identity.',
          );
        }
        invariant(
          records.length > 0 &&
            new Set(records.map((x) => x.id)).size === records.length,
          'EMPTY_OR_DUPLICATE_PLAN',
          'A plan requires distinct original transactions.',
        );
        invariant(
          index.ids.length + records.length <= 50000,
          'LOCAL_OUTBOX_LIMIT',
          'The safe local transaction index is full. Retain facts; do not truncate or overwrite old transactions.',
        );
        if (!plan)
          for (const record of records)
            for (const priorId of index.ids) {
              const prior = await this.record(priorId);
              if (
                prior.kind !== record.kind ||
                !['prepared', 'dispatching', 'unknown'].includes(prior.state)
              )
                continue;
              const recovery = prior.recovery as
                  { kind?: unknown; sequence?: unknown } | undefined,
                newInput = record.args.input as { sequence?: unknown },
                oldInput = prior.args.input as { sequence?: unknown };
              const observed =
                prior.kind === 'progress' &&
                prior.state === 'unknown' &&
                recovery?.kind === 'watermark' &&
                typeof recovery.sequence === 'string' &&
                /^(0|[1-9][0-9]*)$/.test(recovery.sequence) &&
                typeof newInput.sequence === 'number' &&
                typeof oldInput.sequence === 'number' &&
                BigInt(recovery.sequence) >= BigInt(oldInput.sequence) &&
                BigInt(newInput.sequence) > BigInt(recovery.sequence);
              invariant(
                observed,
                'OUTBOX_RECOVERY_REQUIRED',
                'Another original transaction of this kind is unresolved; no second identity was prepared.',
              );
            }
        for (const record of records) {
          recordSchema.parse(record);
          invariant(
            digest(record.args) === record.payloadDigest,
            'OUTBOX_DIGEST_MISMATCH',
            'Prepared payload does not match its frozen digest.',
          );
          invariant(
            !index.ids.includes(record.id),
            'OUTBOX_ID_CONFLICT',
            'Outbox identity already exists.',
          );
          invariant(
            (await this.facts.workspace.readText(
              this.key(`outboxes/${record.id}.json`),
            )) === null,
            'ORPHAN_DELIVERY',
            'Unindexed original bytes exist; do not overwrite them.',
          );
        }
        index.preparing = records.map((x) => x.id);
        await this.saveIndex(index);
        for (const record of records) await this.saveRecord(record);
        index.ids.push(...index.preparing);
        index.preparing = null;
        const result = {
          id: randomUUID(),
          runItemIds: plan?.runItemIds ?? [],
          selectionDigest:
            plan?.selectionDigest ??
            digest(records.map((x) => x.payloadDigest)),
          batchIds: records.map((x) => x.id),
        };
        if (plan) index.plans.push(result);
        await this.saveIndex(index);
        return result;
      },
    );
  }
  async update(recordId: string, change: (record: V2Outbox) => V2Outbox) {
    return this.facts.workspace.withExclusive(
      this.key('mutation'),
      async () => {
        const index = await this.index();
        invariant(
          index.ids.includes(recordId),
          'OUTBOX_NOT_FOUND',
          'No original outbox exists.',
        );
        const original = await this.record(recordId),
          next = change(structuredClone(original));
        invariant(
          next.id === original.id &&
            next.kind === original.kind &&
            next.tool === original.tool &&
            next.payloadDigest === original.payloadDigest &&
            canonical(next.args) === canonical(original.args),
          'OUTBOX_ID_CONFLICT',
          'A transition cannot rewrite original transaction semantics.',
        );
        if (original.state === 'acknowledged')
          invariant(
            next.state === 'acknowledged' &&
              canonical(next.receipt) === canonical(original.receipt),
            'RECEIPT_IMMUTABLE',
            'An acknowledged original receipt cannot be replaced.',
          );
        recordSchema.parse(next);
        await this.saveRecord(next);
        return next;
      },
    );
  }
  async dispatching(recordId: string) {
    return this.update(recordId, (r) => {
      invariant(
        r.state === 'prepared',
        'OUTBOX_RECOVERY_REQUIRED',
        'Only an unsent prepared transaction can dispatch. Query the original receipt for dispatching/unknown first.',
      );
      return { ...r, state: 'dispatching' };
    });
  }
  async retryKnown(recordId: string, reason: string) {
    invariant(
      reason.trim().length > 0,
      'REASON_REQUIRED',
      'Explicit original-payload retry needs a reason.',
    );
    return this.update(recordId, (r) => {
      invariant(
        r.state === 'rejected' &&
          r.failure &&
          ['notDispatched', 'knownFailed'].includes(r.failure.certainty),
        'OUTBOX_RECOVERY_REQUIRED',
        'Unknown writes cannot be reclassified as safe retries.',
      );
      return { ...r, state: 'prepared', retryReason: reason };
    });
  }
  async locallyStopped() {
    let stopped = false;
    for (const r of (await this.read()).records) {
      if (r.kind === 'end') stopped = true;
      if (r.kind === 'resume' && r.state === 'acknowledged') stopped = false;
    }
    return stopped;
  }
}
