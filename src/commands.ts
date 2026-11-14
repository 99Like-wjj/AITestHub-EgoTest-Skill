import { z } from 'zod';
import { ExecutionStore } from './store.js';
import { ExecutionClient } from './client.js';
import { ExecutionClaim, claimRequestSchema } from './claim.js';
import type { RuntimePorts } from './client.js';
import type { WorkspacePort } from './ports.js';
import { identitySchema, id, localId } from './contracts.js';
import { assertNoSecrets } from './canonical.js';
import { invariant } from './errors.js';

export type CommandPorts = RuntimePorts & {
  workspace: WorkspacePort;
  principal: { actorId: string; platformOrigin: string };
};
const claim = { identity: identitySchema, request: claimRequestSchema };
const commandSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('claim-prepare'), ...claim }),
  z.strictObject({
    command: z.literal('claim-dispatch'),
    ...claim,
    replayReason: z.string().min(1).optional(),
  }),
  z.strictObject({ command: z.literal('claim-recover'), ...claim }),
  z.strictObject({
    command: z.literal('freeze'),
    identity: identitySchema,
    scope: z.unknown(),
  }),
  z.strictObject({ command: z.literal('summary'), runId: id }),
  z.strictObject({ command: z.literal('read-case'), runId: id, runItemId: id }),
  z.strictObject({
    command: z.literal('begin-action'),
    runId: id,
    input: z.unknown(),
  }),
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
    command: z.literal('record-result'),
    runId: id,
    input: z.unknown(),
  }),
  z.strictObject({
    command: z.literal('prepare-progress'),
    runId: id,
    summary: z.string(),
    final: z.boolean().default(false),
  }),
  z.strictObject({
    command: z.literal('prepare-results'),
    runId: id,
    input: z.unknown(),
  }),
  z.strictObject({
    command: z.literal('inspect-outbox'),
    runId: id,
    outboxId: id,
  }),
  z.strictObject({
    command: z.literal('export-result-json'),
    runId: id,
    outboxId: id,
  }),
  z.strictObject({
    command: z.literal('attach-result-json'),
    runId: id,
    outboxId: id,
    localEvidenceId: localId,
  }),
  z.strictObject({
    command: z.literal('remote-preflight'),
    runId: id,
    outboxId: id,
  }),
  z.strictObject({
    command: z.literal('dispatch'),
    runId: id,
    outboxId: id,
    replayReason: z.string().min(1).optional(),
  }),
  z.strictObject({ command: z.literal('recover'), runId: id, outboxId: id }),
]);
/** Trusted host supplies already-authorized ports; request JSON cannot choose HTTP/auth/roots. */
export async function runLocalCommand(
  ports: CommandPorts,
  raw: unknown,
): Promise<unknown> {
  assertNoSecrets(raw);
  const request = commandSchema.parse(raw);
  const principal = identitySchema
    .pick({ actorId: true, platformOrigin: true })
    .parse(ports.principal);
  if ('identity' in request)
    invariant(
      request.identity.actorId === principal.actorId &&
        request.identity.platformOrigin === principal.platformOrigin,
      'OWNER_MISMATCH',
      'Request identity does not match the trusted host principal.',
    );
  if (
    request.command.startsWith('claim-') &&
    'identity' in request &&
    'request' in request
  ) {
    const c = new ExecutionClaim(
      ports.workspace,
      ports.tool,
      ports.result,
      request.identity,
      request.request,
    );
    if (request.command === 'claim-prepare') {
      const state = await c.prepare();
      return {
        status: state.status,
        requestDigest: state.requestDigest,
        localExecutionId: state.identity.localExecutionId,
      };
    }
    if (request.command === 'claim-recover') return c.recover();
    const store = await c.dispatch(
      'replayReason' in request ? request.replayReason : undefined,
    );
    return new ExecutionClient(store, ports).summary();
  }
  if (request.command === 'freeze') {
    const store = await ExecutionStore.freeze(
      ports.workspace,
      request.identity,
      request.scope,
    );
    return new ExecutionClient(store, ports).summary();
  }
  if (!('runId' in request)) throw new Error('Unsupported local command.');
  const store = new ExecutionStore(ports.workspace, request.runId),
    client = new ExecutionClient(store, ports);
  const existing = await store.read();
  invariant(
    existing.identity.actorId === principal.actorId &&
      existing.identity.platformOrigin === principal.platformOrigin,
    'OWNER_MISMATCH',
    'This local run belongs to another host principal; no data was returned or operation dispatched.',
  );
  let value: unknown;
  switch (request.command) {
    case 'summary':
      value = await client.summary();
      break;
    case 'read-case': {
      const view = await store.read(),
        item = view.scope.items.find((x) => x.runItemId === request.runItemId);
      if (!item) throw new Error('Item is outside this frozen scope.');
      value = {
        item,
        result: view.results.get(request.runItemId) ?? null,
        observations: [...view.observations.values()].filter(
          (x) => x.runItemId === request.runItemId,
        ),
      };
      break;
    }
    case 'begin-action':
      value = {
        actionId: await store.beginAction(
          request.input as Parameters<ExecutionStore['beginAction']>[0],
        ),
      };
      break;
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
        request.input as Parameters<ExecutionClient['indexEvidence']>[0],
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
    case 'record-result':
      await store.recordResult(
        request.input as Parameters<ExecutionStore['recordResult']>[0],
      );
      value = { recorded: true };
      break;
    case 'prepare-progress':
      value = await client.prepareProgress(request.summary, request.final);
      break;
    case 'prepare-results':
      value = await client.prepareResults(
        request.input as Parameters<ExecutionClient['prepareResults']>[0],
      );
      break;
    case 'inspect-outbox': {
      const view = await store.read();
      value = view.outboxes.get(request.outboxId) ?? null;
      break;
    }
    case 'export-result-json':
      value = await client.exportResultJson(request.outboxId);
      break;
    case 'attach-result-json':
      value = await client.attachResultJson(
        request.outboxId,
        request.localEvidenceId,
      );
      break;
    case 'remote-preflight':
      value = await client.prepareRemote(request.outboxId);
      break;
    case 'dispatch':
      value = await client.dispatch(request.outboxId, request.replayReason);
      break;
    case 'recover':
      value = await client.recover(request.outboxId);
      break;
    default:
      throw new Error('Unsupported local command.');
  }
  ports.result.assertSafe(value);
  return value;
}
