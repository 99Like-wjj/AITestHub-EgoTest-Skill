import { z } from 'zod';
import { digest, canonical, parseJson, assertNoSecrets } from './canonical.js';
import { id, identitySchema, scope } from './contracts.js';
import type { Identity } from './contracts.js';
import { ExecutionStore } from './store.js';
import type {
  ToolPort,
  ResultPort,
  WorkspacePort,
  ClientFailure,
} from './ports.js';
import { invariant, LocalError, safeErrorCode } from './errors.js';
import { validateToolInput } from './platform-schema.js';

export const claimRequestSchema = z.strictObject({
  projectId: id,
  sourceType: z.enum(['plan', 'retestPreparation']),
  sourceRevisionId: id,
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;
const claimState = z.strictObject({
  format: z.literal('ath.web-execute.claim.v1'),
  identity: identitySchema,
  request: claimRequestSchema,
  requestDigest: z.string(),
  status: z.enum([
    'prepared',
    'dispatched',
    'unknown',
    'rejected',
    'acknowledged',
  ]),
  receipt: z.unknown().optional(),
  recovery: z.unknown().optional(),
  failure: z
    .strictObject({
      code: z.string(),
      certainty: z.enum(['knownFailed', 'notDispatched']),
    })
    .optional(),
});
type ClaimState = z.infer<typeof claimState>;

/** Claim recovery creates no browser and never changes the source revision. */
export class ExecutionClaim {
  readonly stateKey: string;
  readonly identity: Identity;
  readonly request: ClaimRequest;
  private readonly requestDigest: string;
  constructor(
    readonly workspace: WorkspacePort,
    readonly tool: ToolPort,
    readonly result: ResultPort,
    identity: Identity,
    request: ClaimRequest,
  ) {
    this.identity = identitySchema.parse(identity);
    this.request = claimRequestSchema.parse(request);
    this.requestDigest = digest({
      identity: this.identity,
      request: this.request,
    });
    this.stateKey = `claims/${digest({ actorId: this.identity.actorId, localExecutionId: this.identity.localExecutionId })}.json`;
  }
  private async load(): Promise<ClaimState> {
    const text = await this.workspace.readText(this.stateKey);
    invariant(
      text !== null,
      'CLAIM_NOT_FOUND',
      'Prepare the original claim before dispatch.',
    );
    let value: ClaimState;
    try {
      value = claimState.parse(parseJson(text));
    } catch {
      throw new LocalError(
        'CORRUPT_CLAIM',
        'Claim state is damaged and was not overwritten.',
      );
    }
    invariant(
      value.requestDigest === this.requestDigest &&
        digest({ identity: value.identity, request: value.request }) ===
          this.requestDigest,
      'CLAIM_ID_CONFLICT',
      'This local execution key is already bound to another source or identity.',
    );
    return value;
  }
  private async save(value: ClaimState) {
    assertNoSecrets(value);
    await this.workspace.writeTextAtomic(this.stateKey, canonical(value));
  }
  async prepare() {
    return this.workspace.withExclusive(this.stateKey, async () => {
      if ((await this.workspace.readText(this.stateKey)) !== null)
        return this.load();
      const value: ClaimState = {
        format: 'ath.web-execute.claim.v1',
        identity: this.identity,
        request: this.request,
        requestDigest: this.requestDigest,
        status: 'prepared',
      };
      await this.save(value);
      return value;
    });
  }
  private async call(name: string, args: Record<string, unknown>) {
    this.result.assertSafe(args);
    validateToolInput(name, args);
    const value = this.result.read(await this.tool.callTool(name, args));
    this.result.assertSafe(value);
    return value;
  }
  private async accept(raw: unknown, state: ClaimState) {
    const receipt = z
        .object({
          runId: id,
          scope: z.unknown(),
          executionProvenance: z.enum([
            'local-ai',
            'protocol-synthetic',
            'unknown',
          ]),
        })
        .passthrough()
        .parse(raw),
      fixed = scope(receipt.scope);
    invariant(
      fixed.runId === receipt.runId &&
        fixed.projectId === this.request.projectId &&
        fixed.sourceType === this.request.sourceType &&
        fixed.sourceRevisionId === this.request.sourceRevisionId &&
        receipt.executionProvenance === this.identity.executionProvenance,
      'CLAIM_SCOPE_MISMATCH',
      'Claim receipt does not match the frozen original request.',
    );
    const store = await ExecutionStore.freeze(
      this.workspace,
      this.identity,
      fixed,
    );
    await this.save({ ...state, status: 'acknowledged', receipt });
    return store;
  }
  /** v2 entry only: an unconfirmed original can only be recovered, never replayed. */
  async dispatchKnownOriginal(
    explicitOriginalRetryReason?: string,
  ): Promise<ExecutionStore> {
    return this.workspace.withExclusive(this.stateKey, async () => {
      const state = await this.load();
      if (state.status === 'acknowledged')
        return this.accept(state.receipt, state);
      invariant(
        state.status === 'prepared' ||
          (state.status === 'rejected' &&
            state.failure !== undefined &&
            explicitOriginalRetryReason?.trim()),
        'CLAIM_RECOVERY_REQUIRED',
        'An unknown/dispatched claim permits only original-operation lookup; a reason or a 404 does not authorize another write.',
      );
      const attempt = { ...state };
      delete attempt.failure;
      await this.save({ ...attempt, status: 'dispatched' });
      try {
        return await this.accept(
          await this.call('ath_ui_executions', {
            op: 'claim',
            projectId: this.request.projectId,
            input: {
              sourceType: this.request.sourceType,
              sourceRevisionId: this.request.sourceRevisionId,
              localExecutionId: this.identity.localExecutionId,
              executionProvenance: this.identity.executionProvenance,
            },
          }),
          attempt,
        );
      } catch (error) {
        const e = error as Partial<ClientFailure>,
          certainty = e.certainty;
        await this.save({
          ...attempt,
          status:
            certainty === 'knownFailed' || certainty === 'notDispatched'
              ? 'rejected'
              : 'unknown',
          ...(certainty === 'knownFailed' || certainty === 'notDispatched'
            ? { failure: { code: safeErrorCode(error), certainty } }
            : {}),
        });
        throw new LocalError(
          safeErrorCode(error, 'CLAIM_OUTCOME_UNKNOWN'),
          'Original claim is not acknowledged. Keep the original identity and recover its receipt; no browser action was started by this tool.',
        );
      }
    });
  }
  async recover() {
    return this.workspace.withExclusive(this.stateKey, async () => {
      const state = await this.load();
      try {
        const raw = await this.call('ath_operation_status', {
            op: 'get',
            operation: `ui-executions.claim.${this.request.sourceRevisionId}`,
            key: this.identity.localExecutionId,
          }),
          value = z
            .object({
              command: z
                .object({
                  operation: z.string(),
                  projectId: id.nullable(),
                  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
                  response: z.unknown(),
                })
                .passthrough(),
            })
            .parse(raw);
        invariant(
          value.command.operation ===
            `ui-executions.claim.${this.request.sourceRevisionId}` &&
            value.command.projectId === this.request.projectId,
          'CLAIM_SCOPE_MISMATCH',
          'Operation status is for another claim.',
        );
        await this.save({
          ...state,
          recovery: { state: value.command.status },
        });
        if (value.command.status === 'completed') {
          const store = await this.accept(value.command.response, {
            ...state,
            recovery: { state: 'completed' },
          });
          return { state: 'found' as const, runId: store.runId };
        }
        return { state: value.command.status, automaticReplay: false };
      } catch (error) {
        const e = error as Partial<ClientFailure>;
        const recovery = {
          state: e.code === 'NOT_FOUND' ? 'not-found-currently' : 'unconfirmed',
          automaticReplay: false,
          originalOperationMayHaveOccurred: true,
        };
        await this.save({ ...state, recovery });
        return recovery;
      }
    });
  }
}
