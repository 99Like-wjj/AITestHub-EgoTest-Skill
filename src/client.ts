import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { z } from 'zod';
import { digest } from './canonical.js';
import { invariant, LocalError, safeErrorCode } from './errors.js';
import { id, sha, bytes } from './contracts.js';
import { ExecutionStore, safeRelativeEvidence } from './store.js';
import type { LocalEvidence } from './store.js';
import type {
  ToolPort,
  ResultPort,
  FileChannelPort,
  ClientFailure,
  RegisteredFile,
} from './ports.js';
import { validateToolInput } from './platform-schema.js';

export interface RuntimePorts {
  tool: ToolPort;
  result: ResultPort;
  files: FileChannelPort;
  privateRoot: string;
}
export class EvidenceFileClient {
  constructor(
    readonly store: ExecutionStore,
    readonly ports: RuntimePorts,
  ) {
    invariant(
      isAbsolute(ports.privateRoot),
      'UNSAFE_PATH',
      'The coordinated workspace requires an explicit absolute private root.',
    );
  }
  evidencePath(relativePath: string): string {
    safeRelativeEvidence(relativePath);
    const root = resolve(this.ports.privateRoot, this.store.prefix),
      target = resolve(root, relativePath),
      rel = relative(root, target);
    invariant(
      !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`),
      'UNSAFE_PATH',
      'Evidence path escaped this run.',
    );
    return target;
  }
  async indexEvidence(input: Omit<LocalEvidence, 'sha256' | 'bytes'>) {
    const actual = await this.ports.files.inspectFile(
      this.evidencePath(input.relativePath),
    );
    await this.store.indexEvidence({ ...input, ...actual });
    return {
      localEvidenceId: input.localEvidenceId,
      ...actual,
      sourceFactNotProvenByHash: true,
    };
  }
  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.ports.result.assertSafe(args);
    validateToolInput(name, args);
    const raw = await this.ports.tool.callTool(name, structuredClone(args)),
      value = this.ports.result.read(raw);
    this.ports.result.assertSafe(value);
    return value;
  }
  async uploadEvidence(
    localEvidenceId: string,
    explicitRetransmissionReason?: string,
  ) {
    return this.store.workspace.withExclusive(
      `${this.store.prefix}/file-transfer`,
      async () => {
        const view = await this.store.read(),
          e = view.evidence.get(localEvidenceId);
        invariant(
          e,
          'EVIDENCE_NOT_FOUND',
          'Evidence must be indexed before platform upload.',
        );
        invariant(
          e.upload === 'local' ||
            (e.upload !== 'verified' &&
              e.lastRecovery !== undefined &&
              explicitRetransmissionReason?.trim()),
          'FILE_RECOVERY_REQUIRED',
          'A prior upload identity exists; query its receipt before an explicit full retransmission.',
        );
        invariant(
          BigInt(e.bytes) <= 104857600n,
          'FILE_BYTE_LIMIT',
          'Indexed evidence exceeds the platform 100MiB file channel; original data remains local.',
        );
        const localFileId = `ath-e-${digest({ runId: view.scope.runId, localEvidenceId: e.localEvidenceId })}`;
        await this.store.beginFileUpload(localEvidenceId, localFileId);
        try {
          const result = await this.ports.files.uploadFile({
            projectId: view.scope.projectId,
            runId: view.scope.runId,
            absolutePath: this.evidencePath(e.relativePath),
            localFileId,
            originalName: e.originalName,
            mediaType: e.mediaType,
            expected: { bytes: e.bytes, sha256: e.sha256 },
            onRegistered: async (registered) => {
              this.checkFile(registered, e);
              invariant(
                registered.localFileId === localFileId,
                'FILE_ID_CONFLICT',
                'Registration has another local identity.',
              );
              await this.store.fileStatus(
                localEvidenceId,
                'registered',
                registered,
              );
            },
          });
          const registered = (await this.store.read()).evidence.get(
            localEvidenceId,
          );
          invariant(
            registered?.fileId === result.fileId &&
              result.status === 'verified' &&
              result.localFileId === localFileId,
            'UNVERIFIED_FILE',
            'Upload did not retain its original registration and verified receipt.',
          );
          this.checkFile(result, e);
          await this.store.fileStatus(localEvidenceId, 'verified', result);
          return result;
        } catch (error) {
          await this.store.fileStatus(localEvidenceId, 'unknown');
          throw this.safeFailure(error);
        }
      },
    );
  }
  private checkFile(
    value: RegisteredFile,
    expected: { bytes: string; sha256: string },
  ) {
    id.parse(value.fileId);
    sha.parse(value.sha256);
    bytes.parse(value.bytes);
    invariant(
      value.bytes === expected.bytes && value.sha256 === expected.sha256,
      'FILE_DIGEST_MISMATCH',
      'Platform file receipt differs from the indexed original.',
    );
  }
  async recoverEvidence(localEvidenceId: string) {
    const v = await this.store.read(),
      e = v.evidence.get(localEvidenceId);
    invariant(
      e?.localFileId,
      'FILE_NOT_REGISTERED',
      'No prior local upload identity exists.',
    );
    if (!e.fileId) {
      const value = {
        status: 'registration-unconfirmed',
        localFileId: e.localFileId,
        retransmissionNotAutomatic: true,
      };
      await this.store.recoveredFile(localEvidenceId, value);
      return value;
    }
    const raw = await this.call('ath_file_transfers', {
        op: 'receipt',
        fileId: e.fileId,
      }),
      parsed = z
        .object({
          file: z
            .object({
              id,
              projectId: id.nullable(),
              runId: id.nullable(),
              sha256: sha,
              bytes,
              status: z.enum(['pending', 'uploading', 'verified', 'failed']),
            })
            .passthrough(),
        })
        .parse(raw);
    invariant(
      parsed.file.id === e.fileId &&
        parsed.file.projectId === v.scope.projectId &&
        parsed.file.runId === v.scope.runId,
      'FILE_SCOPE_MISMATCH',
      'Recovered file belongs to another run/project.',
    );
    this.checkFile(
      { ...parsed.file, fileId: parsed.file.id, localFileId: e.localFileId },
      e,
    );
    const value = {
      fileId: e.fileId,
      status: parsed.file.status,
      retransmissionNotAutomatic: true,
    };
    await this.store.recoveredFile(localEvidenceId, value);
    if (parsed.file.status === 'verified')
      await this.store.fileStatus(localEvidenceId, 'verified', {
        fileId: e.fileId,
        localFileId: e.localFileId,
        bytes: e.bytes,
        sha256: e.sha256,
      });
    return value;
  }
  async verifyEvidence(localEvidenceId: string) {
    const view = await this.store.read();
    const original = view.evidence.get(localEvidenceId);
    invariant(
      original?.upload === 'verified' && original.fileId,
      'EVIDENCE_NOT_VERIFIED',
      'Readback needs the original verified file receipt. Reconcile pending uploads first.',
    );
    const local = await this.ports.files.inspectFile(
      this.evidencePath(original.relativePath),
    );
    invariant(
      local.bytes === original.bytes && local.sha256 === original.sha256,
      'LOCAL_EVIDENCE_CHANGED',
      'The indexed evidence differs from the retained local file.',
    );
    const key = `evidence/readback/${randomUUID()}.bin`;
    const downloaded = await this.ports.files.downloadToFile({
      projectId: view.scope.projectId,
      sourcePath: `/api/v1/files/${original.fileId}/content`,
      destinationPath: this.evidencePath(key),
      expected: local,
    });
    invariant(
      downloaded.expectedIntegrityMatched &&
        downloaded.bytes === local.bytes &&
        downloaded.sha256 === local.sha256,
      'FILE_DIGEST_MISMATCH',
      'Readback bytes differ from the indexed original.',
    );
    return {
      localEvidenceId,
      fileId: original.fileId,
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
      readbackRelativePath: key,
      originalBytesMatched: true,
    };
  }
  private safeFailure(error: unknown): LocalError {
    const e = error as Partial<ClientFailure>;
    return new LocalError(
      safeErrorCode(error),
      e.certainty === 'knownFailed'
        ? 'Platform rejected the original operation; sensitive detail omitted.'
        : 'Original outcome is unconfirmed; query its receipt, do not repeat SUT actions.',
    );
  }
}
