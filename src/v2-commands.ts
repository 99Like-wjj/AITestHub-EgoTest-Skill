import { z } from 'zod';
import { id, localId, identitySchema } from './contracts.js';
import { ExecutionClaim, claimRequestSchema } from './claim.js';
import type { RuntimePorts } from './client.js';
import type { WorkspacePort } from './ports.js';
import { assertNoSecrets } from './canonical.js';
import { invariant, LocalError, safeErrorCode } from './errors.js';
import { ExecutionStore } from './store.js';
import { V2Workspace } from './v2-workspace.js';
import { V2ExecutionClient } from './v2-client.js';

export type CommandPorts = RuntimePorts & {
  workspace: WorkspacePort;
  principal: { actorId: string; platformOrigin: string };
};
const claimInput = { identity: identitySchema, request: claimRequestSchema };
const command = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('claim-prepare'), ...claimInput }),
  z.strictObject({ command: z.literal('claim-recover'), ...claimInput }),
  z.strictObject({
    command: z.literal('claim-dispatch'),
    ...claimInput,
    replayReason: z.string().min(1).optional(),
  }),
  z.strictObject({
    command: z.literal('freeze'),
    identity: identitySchema,
    scope: z.unknown(),
  }),
  z.strictObject({ command: z.literal('summary'), runId: id }),
  z.strictObject({ command: z.literal('read-case'), runId: id, runItemId: id }),
  z.strictObject({
    command: z.literal('action-status'),
    runId: id,
    actionId: id,
    status: z.enum(['dispatched', 'observed', 'unknown', 'notOccurred']),
    reason: z.string().optional(),
  }),
  z.strictObject({
    command: z.literal('observe'),
    runId: id,
    input: z.unknown(),
  }),
  z.strictObject({
    command: z.literal('index-evidence'),
    runId: id,
    input: z.unknown(),
  }),
  z.strictObject({
    command: z.literal('upload-evidence'),
    runId: id,
    localEvidenceId: localId,
    retransmissionReason: z.string().min(1).optional(),
  }),
  z.strictObject({
    command: z.literal('recover-file'),
    runId: id,
    localEvidenceId: localId,
  }),
  z.strictObject({
    command: z.literal('verify-evidence'),
    runId: id,
    localEvidenceId: localId,
  }),
  z.strictObject({
    command: z.literal('begin-action'),
    runId: id,
    input: z.unknown(),
  }),
  z.strictObject({
    command: z.literal('record-result'),
    runId: id,
    input: z.unknown(),
  }),
  z.strictObject({
    command: z.literal('record-not-executed'),
    runId: id,
    input: z.strictObject({
      runItemId: id,
      localResultId: localId,
      reason: z.string().min(1),
      endedAt: z.string().optional(),
    }),
  }),
  z.strictObject({
    command: z.literal('prepare-delivery'),
    runId: id,
    runItemIds: z.array(id).optional(),
    allowPendingFiles: z.boolean().default(false),
  }),
  z.strictObject({
    command: z.literal('inspect-v2-outbox'),
    runId: id,
    outboxId: id,
  }),
  z.strictObject({
    command: z.literal('export-batch-json'),
    runId: id,
    outboxId: id,
  }),
  z.strictObject({
    command: z.literal('attach-batch-json'),
    runId: id,
    outboxId: id,
    localEvidenceId: localId,
  }),
  z.strictObject({
    command: z.literal('v2-preflight'),
    runId: id,
    outboxId: id,
  }),
  z.strictObject({
    command: z.literal('v2-dispatch'),
    runId: id,
    outboxId: id,
  }),
  z.strictObject({ command: z.literal('v2-recover'), runId: id, outboxId: id }),
  z.strictObject({
    command: z.literal('retry-known-v2-failure'),
    runId: id,
    outboxId: id,
    reason: z.string().min(1),
  }),
  z.strictObject({
    command: z.literal('v2-status'),
    runId: id,
    pageKind: z
      .enum(['items', 'files', 'batches', 'descriptors', 'facts'])
      .default('items'),
    allPages: z.boolean().default(false),
  }),
  z.strictObject({
    command: z.literal('prepare-end'),
    runId: id,
    input: z.strictObject({
      endKind: z.enum(['normal', 'terminated', 'interrupted']),
      endedAt: z.string(),
      reason: z.string().optional(),
    }),
  }),
  z.strictObject({
    command: z.literal('prepare-resume'),
    runId: id,
    input: z.strictObject({ resumedAt: z.string(), reason: z.string().min(1) }),
  }),
  z.strictObject({ command: z.literal('prepare-seal'), runId: id }),
  z.strictObject({
    command: z.literal('prepare-progress'),
    runId: id,
    summary: z.string(),
    final: z.boolean().default(false),
  }),
]);

/** New default host entry. It cannot select credentials/transport/root or run Ego/SUT itself. */
export async function runV2LocalCommand(
  ports: CommandPorts,
  raw: unknown,
): Promise<unknown> {
  try {
    assertNoSecrets(raw);
    ports.result.assertSafe(raw);
    const name = z.object({ command: z.string() }).parse(raw).command;
    invariant(
      ![
        'prepare-results',
        'inspect-outbox',
        'export-result-json',
        'attach-result-json',
        'remote-preflight',
        'dispatch',
        'recover',
      ].includes(name),
      'LEGACY_COMMAND_UNSUPPORTED',
      'Use the preserved original package for v1 commands/journals; v2 uses explicit v2 batch transactions.',
    );
    const request = command.parse(raw);
    const principal = identitySchema
      .pick({ actorId: true, platformOrigin: true })
      .parse(ports.principal);
    const workspace = new V2Workspace(ports.workspace);
    if ('identity' in request) {
      invariant(
        request.identity.actorId === principal.actorId &&
          request.identity.platformOrigin === principal.platformOrigin,
        'OWNER_MISMATCH',
        'Request identity does not match the trusted host principal.',
      );
      let value: unknown;
      if (request.command === 'freeze') {
        const client = await V2ExecutionClient.freeze(
          ports,
          request.identity,
          request.scope,
        );
        value = await client.summary();
      } else {
        const claim = new ExecutionClaim(
          workspace,
          ports.tool,
          ports.result,
          request.identity,
          request.request,
        );
        switch (request.command) {
          case 'claim-prepare': {
            const state = await claim.prepare();
            value = {
              status: state.status,
              requestDigest: state.requestDigest,
              localExecutionId: state.identity.localExecutionId,
            };
            break;
          }
          case 'claim-recover':
            value = await claim.recover();
            break;
          case 'claim-dispatch': {
            const store = await claim.dispatchKnownOriginal(
              request.replayReason,
            );
            value = await new V2ExecutionClient(store, ports).summary();
            break;
          }
        }
      }
      ports.result.assertSafe(value);
      return value;
    }
    const store = new ExecutionStore(workspace, request.runId);
    const client = new V2ExecutionClient(store, ports);
    const view = await store.read();
    invariant(
      view.identity.actorId === principal.actorId &&
        view.identity.platformOrigin === principal.platformOrigin,
      'OWNER_MISMATCH',
      'Local journal is owned by another host principal.',
    );
    let value: unknown;
    switch (request.command) {
      case 'summary':
        value = await client.summary();
        break;
      case 'read-case': {
        const item = view.scope.items.find(
          (entry) => entry.runItemId === request.runItemId,
        );
        invariant(item, 'OUTSIDE_SCOPE', 'Item is outside this frozen scope.');
        value = {
          item,
          result: view.results.get(request.runItemId) ?? null,
          observations: [...view.observations.values()].filter(
            (entry) => entry.runItemId === request.runItemId,
          ),
        };
        break;
      }
      case 'action-status':
        await store.actionStatus(
          request.actionId,
          request.status,
          request.reason,
        );
        value = { recorded: true };
        break;
      case 'observe':
        value = {
          observationId: await store.observe(
            request.input as Parameters<ExecutionStore['observe']>[0],
          ),
        };
        break;
      case 'index-evidence':
        value = await client.indexEvidence(
          request.input as Parameters<V2ExecutionClient['indexEvidence']>[0],
        );
        break;
      case 'upload-evidence':
        value = await client.uploadEvidence(
          request.localEvidenceId,
          request.retransmissionReason,
        );
        break;
      case 'recover-file':
        value = await client.recoverEvidence(request.localEvidenceId);
        break;
      case 'verify-evidence':
        value = await client.verifyEvidence(request.localEvidenceId);
        break;
      case 'begin-action':
        value = {
          actionId: await client.beginAction(
            request.input as Parameters<V2ExecutionClient['beginAction']>[0],
          ),
        };
        break;
      case 'record-result':
        await client.recordResult(
          request.input as Parameters<V2ExecutionClient['recordResult']>[0],
        );
        value = { recorded: true };
        break;
      case 'record-not-executed':
        await client.recordNotExecuted(request.input);
        value = { recorded: true };
        break;
      case 'prepare-delivery':
        value = await client.prepareDelivery(
          request.runItemIds,
          request.allowPendingFiles,
        );
        break;
      case 'inspect-v2-outbox':
        value = await client.delivery.get(request.outboxId);
        break;
      case 'export-batch-json':
        value = await client.exportBatchJson(request.outboxId);
        break;
      case 'attach-batch-json':
        value = await client.attachBatchJson(
          request.outboxId,
          request.localEvidenceId,
        );
        break;
      case 'v2-preflight':
        value = await client.preflight(request.outboxId);
        break;
      case 'v2-dispatch':
        value = await client.dispatch(request.outboxId);
        break;
      case 'v2-recover':
        value = await client.recover(request.outboxId);
        break;
      case 'retry-known-v2-failure':
        value = await client.delivery.retryKnown(
          request.outboxId,
          request.reason,
        );
        break;
      case 'v2-status':
        value = request.allPages
          ? await client.statusAll(request.pageKind)
          : await client.status(request.pageKind);
        break;
      case 'prepare-end':
        value = await client.prepareEnd(request.input);
        break;
      case 'prepare-resume':
        value = await client.prepareResume(request.input);
        break;
      case 'prepare-seal':
        value = await client.prepareSeal();
        break;
      case 'prepare-progress':
        value = await client.prepareProgress(request.summary, request.final);
        break;
    }
    ports.result.assertSafe(value);
    return value;
  } catch (error) {
    if (error instanceof LocalError) throw error;
    throw new LocalError(
      safeErrorCode(error, 'V2_OPERATION_UNCONFIRMED'),
      'Local v2 command failed or is unconfirmed. Original records were retained; do not replay SUT actions.',
    );
  }
}
