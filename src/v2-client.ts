import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ExecutionStore } from './store.js';
import { ExecutionClient } from './client.js';
import type { CommandPorts } from './commands.js';
import type { Identity, ManifestItem, Progress } from './contracts.js';
import { id, time, progressSchema } from './contracts.js';
import type { LocalEvidence, LocalResult } from './store.js';
import { canonical, digest, bytesHash } from './canonical.js';
import { invariant, safeErrorCode } from './errors.js';
import { V2Workspace } from './v2-workspace.js';
import { V2DeliveryStore, type V2Kind, type V2Outbox } from './v2-store.js';
import { assertBatchBudget, planV2Batches } from './v2-planner.js';
import {
  readV2,
  validateV2Tool,
  type BatchReceipt,
  type DeliveryStatus,
  type ExecutionFact,
  type ResultBatch,
} from './v2-contracts.js';

const operations = {
  end: 'ui-executions.declare-end',
  resume: 'ui-executions.declare-resume',
  seal: 'results.ui-delivery.seal',
} as const;
const wireLimit = 1024 * 1024 - 4096;
const factReceipt = z
  .object({
    runId: id,
    snapshotDigest: z.string(),
    mode: z.string(),
    rowVersion: z.number(),
    headRowVersion: z.number(),
    state: z.string(),
    fact: z.unknown(),
    localExecutionStartedRemotely: z.literal(false),
  })
  .passthrough();
export class V2ExecutionClient {
  readonly delivery: V2DeliveryStore;
  private readonly files: ExecutionClient;
  constructor(
    readonly store: ExecutionStore,
    readonly ports: CommandPorts,
  ) {
    invariant(
      store.workspace instanceof V2Workspace,
      'V2_NAMESPACE_REQUIRED',
      'Use a v2 workspace; old journals are not silently migrated.',
    );
    this.delivery = new V2DeliveryStore(store);
    this.files = new ExecutionClient(store, {
      ...ports,
      privateRoot: resolve(ports.privateRoot, 'v2'),
    });
  }
  static async freeze(ports: CommandPorts, identity: Identity, raw: unknown) {
    ports.result.assertSafe(identity);
    ports.result.assertSafe(raw);
    invariant(
      identity.actorId === ports.principal.actorId &&
        identity.platformOrigin === ports.principal.platformOrigin,
      'OWNER_MISMATCH',
      'Scope identity does not match the trusted host.',
    );
    return new V2ExecutionClient(
      await ExecutionStore.freeze(
        new V2Workspace(ports.workspace),
        identity,
        raw,
      ),
      ports,
    );
  }
  private async view() {
    const view = await this.store.read();
    invariant(
      view.identity.actorId === this.ports.principal.actorId &&
        view.identity.platformOrigin === this.ports.principal.platformOrigin,
      'OWNER_MISMATCH',
      'This local run belongs to another trusted host principal.',
    );
    return view;
  }
  private async call(name: string, args: Record<string, unknown>) {
    this.ports.result.assertSafe(args);
    validateV2Tool(name, args);
    const value = this.ports.result.read(
      await this.ports.tool.callTool(name, structuredClone(args)),
    );
    this.ports.result.assertSafe(value);
    return value;
  }
  evidencePath(relativePath: string) {
    return this.files.evidencePath(relativePath);
  }
  async indexEvidence(input: Omit<LocalEvidence, 'sha256' | 'bytes'>) {
    await this.view();
    this.ports.result.assertSafe(input);
    return this.files.indexEvidence(input);
  }
  async uploadEvidence(localEvidenceId: string, reason?: string) {
    await this.view();
    return this.files.uploadEvidence(localEvidenceId, reason);
  }
  async recoverEvidence(localEvidenceId: string) {
    await this.view();
    return this.files.recoverEvidence(localEvidenceId);
  }

  private checkStatus(value: unknown): DeliveryStatus {
    const status = readV2<DeliveryStatus>('uiDeliveryStatusSchema', value);
    invariant(
      status.runId === this.store.runId,
      'STATUS_SCOPE_MISMATCH',
      'Remote status is for another execution.',
    );
    return status;
  }
  async status(
    pageKind: DeliveryStatus['page']['kind'] = 'items',
    afterId?: string,
    limit = 200,
  ) {
    const view = await this.view();
    const query = {
      pageKind,
      limit,
      ...(afterId !== undefined ? { afterId } : {}),
    };
    const status = this.checkStatus(
      await this.call('ath_results', {
        op: 'ui-delivery-status',
        projectId: view.scope.projectId,
        runId: view.scope.runId,
        query,
      }),
    );
    invariant(
      status.projectId === view.scope.projectId &&
        status.snapshotDigest === view.scope.snapshotDigest &&
        status.executionProvenance === view.identity.executionProvenance &&
        status.totalItems === view.scope.items.length &&
        status.page.kind === pageKind,
      'STATUS_SCOPE_MISMATCH',
      'Remote metadata does not match the original fixed scope.',
    );
    invariant(
      status.page.hasMore
        ? status.page.nextCursor !== null && status.page.items.length > 0
        : status.page.nextCursor === null,
      'STATUS_CURSOR_INVALID',
      'Remote pagination does not truthfully describe its remaining page.',
    );
    return status;
  }
  async statusAll(pageKind: DeliveryStatus['page']['kind'] = 'items') {
    const first = await this.status(pageKind),
      items = [...first.page.items],
      seen = new Set<string>();
    let page = first;
    const watermark = (s: DeliveryStatus) =>
      digest({
        row: s.rowVersion,
        head: s.headRowVersion,
        ledger: s.ledgerVersion,
        ledgerDigest: s.ledgerDigest,
        progress: s.progressSequence,
      });
    while (page.page.hasMore) {
      const next = page.page.nextCursor;
      invariant(
        next && !seen.has(next),
        'STATUS_CURSOR_LOOP',
        'Remote pagination repeated an original cursor; partial pages were not treated as complete.',
      );
      seen.add(next);
      invariant(
        seen.size <= 10000,
        'STATUS_PAGE_LIMIT',
        'Remote pagination exceeds the fixed structural range.',
      );
      page = await this.status(pageKind, next);
      invariant(
        watermark(page) === watermark(first),
        'REMOTE_STATE_CHANGED',
        'Remote artifact/ledger watermark changed during pagination. Read again explicitly; this is not a complete snapshot.',
      );
      items.push(...page.page.items);
    }
    const identifier =
      pageKind === 'items'
        ? 'runItemId'
        : pageKind === 'files'
          ? 'fileId'
          : 'id';
    invariant(
      items.every((x) => typeof x[identifier] === 'string') &&
        new Set(items.map((x) => x[identifier])).size === items.length,
      'STATUS_DUPLICATE_ITEM',
      'Paged metadata repeats or loses a stable object identity.',
    );
    if (pageKind === 'items') {
      const ids = items.map((x) => x.runItemId);
      const view = await this.view();
      invariant(
        ids.length === view.scope.items.length &&
          view.scope.items.every((x) => ids.includes(x.runItemId)),
        'STATUS_SCOPE_MISMATCH',
        'Paged coverage is not the exact fixed item set.',
      );
    }
    if (pageKind === 'batches')
      invariant(
        items.length === first.batchCount,
        'STATUS_SCOPE_MISMATCH',
        'Paged batch index does not cover the advertised batch count.',
      );
    return { status: first, items, complete: true as const };
  }
  async beginAction(input: Parameters<ExecutionStore['beginAction']>[0]) {
    return this.store.workspace.withExclusive(
      `${this.store.prefix}/v2-execution-intent`,
      () => this.beginActionInternal(input),
    );
  }
  private async beginActionInternal(
    input: Parameters<ExecutionStore['beginAction']>[0],
  ) {
    this.ports.result.assertSafe(input);
    const view = await this.view(),
      remote = await this.status();
    invariant(
      !(await this.delivery.locallyStopped()) &&
        !remote.lastFact?.endedAt &&
        ['running', 'stopping'].includes(remote.executionState),
      'EXECUTION_ENDED',
      'This local/remote segment has ended. Explicit verified resume is required; metadata does not start the browser.',
    );
    invariant(
      remote.reportedItems <= view.results.size,
      'LOCAL_FACTS_MISSING',
      'Remote results exceed retained local facts. Counts cannot reconstruct lost actions; reconcile read-only.',
    );
    return this.store.beginAction(input);
  }
  async recordResult(input: LocalResult) {
    await this.view();
    this.ports.result.assertSafe(input);
    if (input.item.originalOutcome === 'notExecuted')
      invariant(
        input.item.reason?.trim(),
        'REASON_REQUIRED',
        'An unexecuted declaration needs its real explicit reason.',
      );
    return this.store.recordResult(input);
  }
  async recordNotExecuted(input: {
    runItemId: string;
    localResultId: string;
    reason: string;
    endedAt?: string | undefined;
  }) {
    invariant(
      input.reason.trim(),
      'REASON_REQUIRED',
      'An explicit unexecuted declaration needs a reason.',
    );
    const coverage = await this.statusAll('items'),
      remote = coverage.items.find((x) => x.runItemId === input.runItemId);
    invariant(
      remote?.status === 'notReported',
      'REMOTE_FACT_EXISTS',
      'A reported or pending original cannot become an unexecuted declaration.',
    );
    return this.recordResult({
      item: {
        runItemId: input.runItemId,
        localResultId: input.localResultId,
        originalOutcome: 'notExecuted',
        actualObservations: `客户端明确声明未执行：${input.reason}`,
        reason: input.reason,
        sideEffectCertainty: 'notApplicable',
        evidenceRefs: [],
        ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      },
      observationIds: [],
      unresolvedActionIds: [],
    });
  }

  private outbox(
    kind: V2Kind,
    tool: V2Outbox['tool'],
    args: Record<string, unknown>,
    recordId: string = randomUUID(),
  ): V2Outbox {
    this.ports.result.assertSafe(args);
    validateV2Tool(tool, args);
    return {
      format: 'ath.web-execute.v2-outbox.v1',
      id: recordId,
      kind,
      tool,
      args,
      payloadDigest: digest(args),
      state: 'prepared',
    };
  }
  async prepareDelivery(
    selectedRunItemIds?: string[],
    allowPendingFiles = false,
  ) {
    const view = await this.view(),
      previous = await this.delivery.read();
    const used = new Set(previous.index.plans.flatMap((x) => x.runItemIds));
    const selected =
      selectedRunItemIds ??
      view.scope.items
        .map((x) => x.runItemId)
        .filter((x) => view.results.has(x) && !used.has(x));
    invariant(
      selected.length > 0 && new Set(selected).size === selected.length,
      'NO_UNPLANNED_RESULTS',
      'Select distinct recorded original results; do not create a replacement plan for unresolved items.',
    );
    const items = selected.map((itemId) => {
      const result = view.results.get(itemId);
      invariant(
        result && view.scope.items.some((x) => x.runItemId === itemId),
        'RESULT_NOT_RECORDED',
        'Selected original result is missing or outside the fixed scope.',
      );
      if (result.item.originalOutcome === 'notExecuted')
        invariant(
          result.item.reason?.trim(),
          'REASON_REQUIRED',
          'An unexecuted result needs its explicit reason.',
        );
      return result.item;
    });
    const manifest = new Map<string, ManifestItem>();
    for (const ref of new Set(items.flatMap((x) => x.evidenceRefs))) {
      const e = view.evidence.get(ref);
      invariant(
        e?.fileId,
        'FILE_NOT_REGISTERED',
        'Every reference must retain its real registered file identity.',
      );
      invariant(
        e.upload === 'verified' || allowPendingFiles,
        'FILE_NOT_VERIFIED',
        'Upload original bytes or explicitly retain pending delivery.',
      );
      const {
        localEvidenceId,
        fileId,
        sha256,
        bytes,
        type,
        captureCompleteness,
        source,
        capturedAt,
      } = e;
      manifest.set(ref, {
        localEvidenceId,
        fileId,
        sha256,
        bytes,
        type,
        captureCompleteness,
        source,
        ...(capturedAt ? { capturedAt } : {}),
      });
    }
    const selectionDigest = digest({
      runId: view.scope.runId,
      scope: view.scope.snapshotDigest,
      items,
      manifest: [...manifest.values()],
    });
    const existing = previous.index.plans.find(
      (p) => p.selectionDigest === selectionDigest,
    );
    if (existing) return existing;
    const batches = planV2Batches({
      runId: view.scope.runId,
      snapshotDigest: view.scope.snapshotDigest,
      items,
      manifest,
    });
    const records = batches.map((batch) =>
      this.outbox(
        'batch',
        'ath_results',
        {
          op: 'receive-ui-batch',
          projectId: view.scope.projectId,
          input: batch,
        },
        batch.batchId,
      ),
    );
    return this.delivery.prepare(records, {
      runItemIds: selected,
      selectionDigest,
    });
  }
  async exportBatchJson(outboxId: string) {
    const view = await this.view(),
      outbox = await this.delivery.get(outboxId);
    invariant(
      outbox.kind === 'batch' && outbox.state === 'prepared',
      'OUTBOX_STATE',
      'Export the original unsent batch, not a regenerated payload.',
    );
    const batch = outbox.args.input as ResultBatch;
    assertBatchBudget(batch);
    const body = canonical(batch),
      localEvidenceId = `batch-source-${outboxId}`,
      relativePath = `evidence/batch-${outboxId}.json`,
      key = `${this.store.prefix}/${relativePath}`;
    const existing = await this.store.workspace.readText(key);
    invariant(
      existing === null || existing === body,
      'ORIGINAL_JSON_MISMATCH',
      'Existing original JSON bytes differ; they were not overwritten.',
    );
    if (existing === null)
      await this.store.workspace.writeTextAtomic(key, body);
    if (!view.evidence.has(localEvidenceId))
      await this.store.indexEvidence({
        localEvidenceId,
        relativePath,
        originalName: `batch-${outboxId}.json`,
        mediaType: 'application/json',
        sha256: bytesHash(Buffer.from(body, 'utf8')),
        bytes: String(Buffer.byteLength(body, 'utf8')),
        type: 'attachment',
        captureCompleteness: 'full',
        source: 'derived',
      });
    return {
      outboxId,
      localEvidenceId,
      relativePath,
      bytes: String(Buffer.byteLength(body, 'utf8')),
      sha256: bytesHash(Buffer.from(body, 'utf8')),
    };
  }
  async attachBatchJson(outboxId: string, localEvidenceId: string) {
    const view = await this.view(),
      record = await this.delivery.get(outboxId),
      e = view.evidence.get(localEvidenceId);
    invariant(
      record.kind === 'batch' && record.state === 'prepared',
      'OUTBOX_STATE',
      'Select original JSON transport before dispatch starts.',
    );
    invariant(
      e?.upload === 'verified' && e.fileId,
      'FILE_NOT_VERIFIED',
      'Bind a verified exact original batch JSON before dispatch.',
    );
    const body = canonical(record.args.input);
    invariant(
      e.mediaType === 'application/json' &&
        e.sha256 === bytesHash(Buffer.from(body, 'utf8')) &&
        e.bytes === String(Buffer.byteLength(body, 'utf8')),
      'ORIGINAL_JSON_MISMATCH',
      'File bytes differ from the frozen original batch.',
    );
    assertBatchBudget(record.args.input as ResultBatch);
    const args = {
      op: 'receive-ui-batch-file',
      projectId: view.scope.projectId,
      fileId: e.fileId,
    };
    await this.delivery.update(outboxId, (r) => {
      invariant(
        r.state === 'prepared',
        'OUTBOX_STATE',
        'File transport cannot be rebound after dispatch started.',
      );
      invariant(
        !r.transportArgs || canonical(r.transportArgs) === canonical(args),
        'ORIGINAL_JSON_MISMATCH',
        'The original file transport is already bound.',
      );
      return {
        ...r,
        transportArgs: args,
        transportDigest: digest(args),
        sourceEvidenceId: localEvidenceId,
      };
    });
    return { outboxId, fileId: e.fileId };
  }
  async preflight(outboxId: string) {
    const record = await this.delivery.get(outboxId);
    invariant(
      record.kind === 'batch',
      'OUTBOX_STATE',
      'Only data batches have read-only preflight.',
    );
    const args = { ...record.args, op: 'prepare-ui-batch' };
    if (Buffer.byteLength(canonical(args), 'utf8') > wireLimit)
      return {
        available: false,
        reason: 'FILE_TRANSPORT_REQUIRED',
        persisted: false,
      };
    const value = readV2<{
        runId: string;
        batchId: string;
        snapshotDigest: string;
        semanticDigest: string;
      }>('uiBatchPreparationSchema', await this.call('ath_results', args)),
      batch = record.args.input as ResultBatch;
    invariant(
      value.runId === batch.runId &&
        value.batchId === batch.batchId &&
        value.snapshotDigest === batch.snapshotDigest &&
        value.semanticDigest === digest(batch),
      'RECEIPT_SCOPE_MISMATCH',
      'Preflight is not for this exact original batch.',
    );
    return value;
  }

  private async prepareCommand(
    kind: 'end' | 'resume' | 'seal',
    input: Record<string, unknown>,
  ) {
    const view = await this.view(),
      records = (await this.delivery.read()).records;
    invariant(
      !records.some(
        (r) =>
          r.kind === kind &&
          ['prepared', 'dispatching', 'unknown'].includes(r.state),
      ),
      'OUTBOX_RECOVERY_REQUIRED',
      'Resolve the original transaction before preparing another of the same kind.',
    );
    const op = {
        end: 'declare-end',
        resume: 'declare-resume',
        seal: 'seal-ui-delivery',
      }[kind],
      recordId = id.parse(input.commandId);
    const record = this.outbox(
      kind,
      kind === 'seal' ? 'ath_results' : 'ath_ui_executions',
      { op, projectId: view.scope.projectId, input },
      recordId,
    );
    await this.delivery.prepare([record]);
    return { outboxId: record.id, input };
  }
  async prepareEnd(input: {
    endKind: 'normal' | 'terminated' | 'interrupted';
    endedAt: string;
    reason?: string | undefined;
  }) {
    return this.store.workspace.withExclusive(
      `${this.store.prefix}/v2-execution-intent`,
      () => this.prepareEndInternal(input),
    );
  }
  private async prepareEndInternal(input: {
    endKind: 'normal' | 'terminated' | 'interrupted';
    endedAt: string;
    reason?: string | undefined;
  }) {
    time.parse(input.endedAt);
    const view = await this.view(),
      status = await this.status();
    invariant(
      status.mode === null || status.mode === 'nativeV2',
      'LEGACY_EXECUTION',
      'Use the original legacy journal/explicit platform workflow; a new v2 journal does not reinterpret v1 end facts.',
    );
    invariant(
      status.lastFact?.kind !== 'end',
      'EXECUTION_ENDED',
      'The current segment already has an end fact.',
    );
    if (input.endKind === 'normal')
      invariant(
        view.scope.items.every((x) => view.results.has(x.runItemId)),
        'LOCAL_SCOPE_INCOMPLETE',
        'Normal ending requires a truthful local result for every fixed item, not generated unexecuted placeholders.',
      );
    return this.prepareCommand('end', {
      commandId: randomUUID(),
      runId: view.scope.runId,
      snapshotDigest: view.scope.snapshotDigest,
      rowVersion: status.rowVersion,
      resumeFactId:
        status.lastFact?.kind === 'resume' ? status.lastFact.id : null,
      endKind: input.endKind,
      endedAt: input.endedAt,
      reason: input.reason ?? '',
    });
  }
  async prepareResume(input: { resumedAt: string; reason: string }) {
    time.parse(input.resumedAt);
    invariant(
      input.reason.trim(),
      'REASON_REQUIRED',
      'Resume requires an explicit real reason.',
    );
    const view = await this.view(),
      status = await this.status();
    invariant(
      status.mode === 'nativeV2' && status.lastFact?.kind === 'end',
      'NO_CURRENT_END',
      'Resume must bind the current native end fact, not recreate an old scope.',
    );
    const local = (await this.delivery.read()).records.find(
      (r) =>
        r.kind === 'end' &&
        r.state === 'acknowledged' &&
        (r.receipt as { fact?: { id?: string } })?.fact?.id ===
          status.lastFact!.id,
    );
    invariant(
      local,
      'LOCAL_FACTS_MISSING',
      'The current end is not an acknowledged local fact. Reconcile the original journal before resuming.',
    );
    return this.prepareCommand('resume', {
      commandId: randomUUID(),
      runId: view.scope.runId,
      snapshotDigest: view.scope.snapshotDigest,
      rowVersion: status.rowVersion,
      endFactId: status.lastFact.id,
      resumedAt: input.resumedAt,
      reason: input.reason,
    });
  }
  async prepareSeal() {
    const view = await this.view(),
      status = await this.status();
    const batches = (await this.delivery.read()).records.filter(
      (r) => r.kind === 'batch',
    );
    invariant(
      batches.length > 0 &&
        batches.every(
          (r) =>
            r.state === 'acknowledged' &&
            !(r.receipt as BatchReceipt).perItemResults.some((x) =>
              ['conflict', 'rejected'].includes(x.status),
            ),
        ),
      'DELIVERY_ACKS_INCOMPLETE',
      'Resolve every original local batch and its per-item conflicts before declaring this delivery sealed.',
    );
    invariant(
      status.mode === 'nativeV2' &&
        status.lastFact?.kind === 'end' &&
        status.notReportedItems === 0 &&
        status.pendingDescriptors === 0,
      'DELIVERY_NOT_COVERED',
      'Seal requires an explicit end and complete accumulated facts; progress/report existence is insufficient.',
    );
    return this.prepareCommand('seal', {
      commandId: randomUUID(),
      runId: view.scope.runId,
      snapshotDigest: view.scope.snapshotDigest,
      expectedLedgerVersion: status.ledgerVersion,
      expectedLedgerDigest: status.ledgerDigest,
      endFactId: status.lastFact.id,
    });
  }
  async prepareProgress(summary: string, final = false) {
    return this.store.workspace.withExclusive(
      `${this.store.prefix}/delivery-v2/prepare-progress`,
      () => this.prepareProgressInternal(summary, final),
    );
  }
  private async prepareProgressInternal(summary: string, final: boolean) {
    const view = await this.view(),
      status = await this.status(),
      records = (await this.delivery.read()).records;
    const completed = [...view.results.values()].filter(
      (x) => x.item.originalOutcome !== 'notExecuted',
    ).length;
    invariant(
      completed >= status.completedItems,
      'LOCAL_FACTS_MISSING',
      'Local facts cannot be reconstructed from the server progress count.',
    );
    for (const r of records.filter(
      (r) =>
        r.kind === 'progress' &&
        ['prepared', 'dispatching', 'unknown'].includes(r.state),
    )) {
      const original = r.args.input as Progress,
        recovery = r.recovery as
          { kind?: string; sequence?: string } | undefined;
      invariant(
        r.state === 'unknown' &&
          recovery?.kind === 'watermark' &&
          BigInt(recovery.sequence ?? '0') >= BigInt(original.sequence),
        'OUTBOX_RECOVERY_REQUIRED',
        'Read the original progress watermark before another sequence; no inference or automatic resend.',
      );
    }
    if (status.progressClosedAt !== null)
      return { due: false, progressClosedAt: status.progressClosedAt };
    if (!final && completed - status.completedItems < 10)
      return { due: false, completedItems: completed };
    const sequence = BigInt(status.progressSequence) + 1n;
    invariant(
      sequence <= BigInt(Number.MAX_SAFE_INTEGER),
      'PROGRESS_SEQUENCE_LIMIT',
      'Current progress exceeds the supported numeric input range.',
    );
    const input = progressSchema.parse({
      runId: view.scope.runId,
      sequence: Number(sequence),
      completedItems: completed,
      summary,
      observedAt: new Date().toISOString(),
    });
    const record = this.outbox('progress', 'ath_ui_executions', {
      op: 'progress',
      projectId: view.scope.projectId,
      input,
    });
    await this.delivery.prepare([record]);
    return { due: true, outboxId: record.id, input };
  }

  private async accept(record: V2Outbox, value: unknown) {
    const view = await this.view();
    let receipt: unknown;
    if (record.kind === 'batch') {
      const input = record.args.input as ResultBatch,
        r = readV2<BatchReceipt>('uiBatchReceiptSchema', value);
      invariant(
        r.batchId === input.batchId &&
          r.runId === view.scope.runId &&
          r.snapshotDigest === view.scope.snapshotDigest &&
          r.semanticDigest === digest(input),
        'RECEIPT_SCOPE_MISMATCH',
        'Original batch receipt does not match the exact frozen payload.',
      );
      const expected = [
        ...input.items.map((x) => `result/${x.runItemId}`),
        ...input.explicitNotExecutedItems.map(
          (x) => `notExecuted/${x.runItemId}`,
        ),
        ...input.descriptors.map((x) => `descriptor/${x.descriptorId}`),
        ...input.evidenceSegments.map(
          (x) => `segment/${x.descriptorId}:${x.segmentIndex}`,
        ),
      ];
      const received = r.perItemResults.map((x) => `${x.kind}/${x.objectId}`);
      invariant(
        received.length === expected.length &&
          new Set(received).size === received.length &&
          received.every((x) => expected.includes(x)),
        'RECEIPT_SCOPE_MISMATCH',
        'Per-item receipt identities differ from this exact batch.',
      );
      const descriptorItems = new Map(
        (await this.delivery.read()).records
          .filter((x) => x.kind === 'batch')
          .flatMap((x) =>
            (x.args.input as ResultBatch).descriptors.map(
              (d) => [d.descriptorId, d.core.runItemId] as const,
            ),
          ),
      );
      for (const row of r.perItemResults) {
        const expectedDescriptor =
          row.kind === 'descriptor'
            ? row.objectId
            : row.kind === 'segment'
              ? (input.evidenceSegments.find(
                  (x) => `${x.descriptorId}:${x.segmentIndex}` === row.objectId,
                )?.descriptorId ?? null)
              : null;
        invariant(
          row.descriptorId === expectedDescriptor,
          'RECEIPT_SCOPE_MISMATCH',
          'Receipt descriptor does not match its exact segment/original item.',
        );
        const expectedItem = expectedDescriptor
          ? descriptorItems.get(expectedDescriptor)
          : row.objectId;
        invariant(
          row.runItemId === expectedItem ||
            (['conflict', 'rejected'].includes(row.status) &&
              row.runItemId === null),
          'RECEIPT_SCOPE_MISMATCH',
          'Per-item receipt points to another fixed item.',
        );
        invariant(
          row.kind === 'result' || row.kind === 'notExecuted'
            ? row.descriptorId === null
            : row.descriptorId !== null,
          'RECEIPT_SCOPE_MISMATCH',
          'Receipt descriptor identity does not match its kind.',
        );
        if (['accepted', 'skipped'].includes(row.status))
          invariant(
            row.resultId !== null && row.revisionId !== null,
            'RECEIPT_SCOPE_MISMATCH',
            'An accepted/skipped original is missing its real result revision.',
          );
      }
      invariant(
        r.resultsAccepted ===
          r.perItemResults.filter(
            (x) => x.status === 'accepted' && x.resultId !== null,
          ).length,
        'RECEIPT_COUNT_MISMATCH',
        'Batch accepted count is inconsistent.',
      );
      const allowed = new Set(
        input.evidenceManifest.map((x) => x.fileId.toLowerCase()),
      );
      if (record.transportArgs)
        allowed.add(String(record.transportArgs.fileId).toLowerCase());
      invariant(
        r.missingFileIds.every((x) => allowed.has(x.toLowerCase())),
        'RECEIPT_SCOPE_MISMATCH',
        'Missing files are outside this batch/source scope.',
      );
      receipt = r;
    } else if (record.kind === 'progress') {
      const r = z
        .object({
          accepted: z.literal(true),
          sequence: z.number().int(),
          progressClosedAt: z.string().nullable(),
        })
        .passthrough()
        .parse(value);
      invariant(
        r.sequence === (record.args.input as Progress).sequence,
        'RECEIPT_SCOPE_MISMATCH',
        'Progress receipt has another original sequence.',
      );
      receipt = value;
    } else if (record.kind === 'seal') {
      const r = readV2<{
          runId: string;
          snapshotDigest: string;
          seal: {
            commandId: string;
            ledgerVersion: string;
            ledgerDigest: string;
            endFactId: string;
            coverageCount: number;
          };
        }>('uiDeliverySealReceiptSchema', value),
        input = record.args.input as Record<string, unknown>;
      invariant(
        r.runId === view.scope.runId &&
          r.snapshotDigest === view.scope.snapshotDigest &&
          r.seal.commandId === input.commandId &&
          r.seal.ledgerVersion === input.expectedLedgerVersion &&
          r.seal.ledgerDigest === input.expectedLedgerDigest &&
          r.seal.endFactId === input.endFactId &&
          r.seal.coverageCount === view.scope.items.length,
        'RECEIPT_SCOPE_MISMATCH',
        'Seal receipt is not the frozen accumulated ledger/end fact.',
      );
      receipt = r;
    } else {
      readV2('uiExecutionFactReceiptSchema', value);
      const r = factReceipt.parse(value),
        fact = r.fact as ExecutionFact,
        input = record.args.input as Record<string, unknown>;
      invariant(
        r.runId === view.scope.runId &&
          r.snapshotDigest === view.scope.snapshotDigest &&
          r.mode === 'nativeV2' &&
          fact.runId === view.scope.runId &&
          fact.commandId === input.commandId &&
          fact.kind === record.kind &&
          fact.provenance === view.identity.executionProvenance &&
          r.rowVersion > Number(input.rowVersion),
        'RECEIPT_SCOPE_MISMATCH',
        'Execution fact receipt does not match this original command/scope.',
      );
      invariant(
        fact.legacyState === null &&
          fact.previousFactId ===
            (record.kind === 'end' ? input.resumeFactId : input.endFactId) &&
          fact.reason ===
            (record.kind === 'resume'
              ? String(input.reason).trim()
              : String(input.reason ?? '')) &&
          r.state ===
            (record.kind === 'resume'
              ? 'running'
              : input.endKind === 'normal'
                ? 'completed'
                : input.endKind),
        'RECEIPT_SCOPE_MISMATCH',
        'Execution fact chain/reason/state differs from the original statement.',
      );
      if (record.kind === 'end')
        invariant(
          fact.endKind === input.endKind &&
            fact.resumeFactId === input.resumeFactId &&
            Date.parse(fact.endedAt!) === Date.parse(String(input.endedAt)),
          'RECEIPT_SCOPE_MISMATCH',
          'End fact changed its precise previous segment/time.',
        );
      else
        invariant(
          fact.endFactId === input.endFactId &&
            Date.parse(fact.resumedAt!) === Date.parse(String(input.resumedAt)),
          'RECEIPT_SCOPE_MISMATCH',
          'Resume fact changed its exact original end/time.',
        );
      receipt = value;
    }
    return this.delivery.update(record.id, (r) => ({
      ...r,
      state: 'acknowledged',
      receipt,
    }));
  }
  async dispatch(outboxId: string) {
    await this.view();
    const record = await this.delivery.get(outboxId),
      args = record.transportArgs ?? record.args;
    invariant(
      Buffer.byteLength(canonical(args), 'utf8') <= wireLimit,
      'FILE_TRANSPORT_REQUIRED',
      'Use the verified original JSON file channel for this batch; no oversized MCP write was dispatched.',
    );
    validateV2Tool(record.tool, args);
    const marked = await this.delivery.dispatching(outboxId),
      actual = marked.transportArgs ?? marked.args;
    try {
      return await this.accept(marked, await this.call(marked.tool, actual));
    } catch (error) {
      const failure = error as { code?: unknown; certainty?: unknown },
        known = ['knownFailed', 'notDispatched'].includes(
          String(failure.certainty),
        );
      await this.delivery.update(outboxId, (r) => ({
        ...r,
        state: known ? 'rejected' : 'unknown',
        failure: {
          code: safeErrorCode(error),
          certainty: known ? String(failure.certainty) : 'unknown',
        },
      }));
      throw error;
    }
  }
  async recover(outboxId: string) {
    const view = await this.view(),
      record = await this.delivery.get(outboxId);
    try {
      if (record.kind === 'progress') {
        const current = await this.status();
        return this.delivery.update(record.id, (r) => ({
          ...r,
          recovery: {
            kind: 'watermark',
            sequence: current.progressSequence,
            completedItems: current.completedItems,
            originalAckConfirmed: false,
          },
        }));
      }
      let response: unknown;
      if (record.kind === 'batch')
        response = await this.call('ath_results', {
          op: 'ui-batch-receipt',
          projectId: view.scope.projectId,
          batchId: (record.args.input as ResultBatch).batchId,
        });
      else {
        const operation = operations[record.kind],
          key = (record.args.input as Record<string, unknown>).commandId;
        const raw = z
          .object({
            command: z.object({
              operation: z.string(),
              projectId: id.nullable(),
              status: z.string(),
              response: z.unknown(),
            }),
          })
          .parse(
            await this.call('ath_operation_status', {
              op: 'get',
              operation,
              key,
            }),
          );
        invariant(
          raw.command.operation === operation &&
            raw.command.projectId === view.scope.projectId &&
            raw.command.status === 'completed' &&
            raw.command.response !== null,
          'ORIGINAL_OPERATION_UNRESOLVED',
          'The original command is not a confirmed completed receipt.',
        );
        response = raw.command.response;
      }
      return this.accept(record, response);
    } catch (error) {
      return this.delivery.update(record.id, (r) => ({
        ...r,
        ...(['dispatching', 'unknown'].includes(r.state)
          ? { state: 'unknown' as const }
          : {}),
        recovery: {
          kind: 'unconfirmed',
          code: safeErrorCode(error),
          automaticReplay: false,
          originalOperationMayHaveOccurred: true,
        },
      }));
    }
  }
  async summary() {
    const view = await this.view(),
      local = await this.delivery.read(),
      unresolved = [...view.actions.values()].filter((x) =>
        ['intent', 'dispatched', 'unknown'].includes(x.status),
      );
    return {
      runId: view.scope.runId,
      snapshotDigest: view.scope.snapshotDigest,
      totalItems: view.scope.items.length,
      recordedLocalResults: view.results.size,
      unresolvedActions: unresolved,
      localEvidence: [...view.evidence.values()].map((x) => ({
        localEvidenceId: x.localEvidenceId,
        upload: x.upload,
        fileId: x.fileId ?? null,
        bytes: x.bytes,
        sha256: x.sha256,
      })),
      localExecutionStopped: await this.delivery.locallyStopped(),
      plans: local.index.plans,
      transactions: local.records.map((r) => ({
        id: r.id,
        kind: r.kind,
        state: r.state,
        hasConflicts:
          r.kind === 'batch' && r.receipt
            ? (r.receipt as BatchReceipt).perItemResults.some((x) =>
                ['conflict', 'rejected'].includes(x.status),
              )
            : false,
      })),
      remoteStateNotInferredFromLocalCounts: true,
      judgmentsAreCallerProvided: true,
    };
  }
}
