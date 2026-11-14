/** Structural copy of the coordinated local-client ABI v0.1; no transport implementation. */
export interface ToolPort {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface ResultPort {
  read(raw: unknown): unknown;
  assertSafe(value: unknown): void;
}
export interface WorkspacePort {
  readText(key: string): Promise<string | null>;
  writeTextAtomic(key: string, text: string): Promise<void>;
  withExclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}
export interface FileDigest {
  bytes: string;
  sha256: string;
}
export interface RegisteredFile extends FileDigest {
  fileId: string;
  localFileId: string;
}
export interface VerifiedUpload extends RegisteredFile {
  status: 'verified';
}
export interface FileChannelPort {
  inspectFile(absolutePath: string): Promise<FileDigest>;
  uploadFile(input: {
    projectId: string;
    runId?: string;
    absolutePath: string;
    localFileId: string;
    originalName: string;
    mediaType: string;
    expected?: FileDigest;
    onRegistered: (file: RegisteredFile) => Promise<void>;
  }): Promise<VerifiedUpload>;
  downloadToFile(input: {
    projectId: string;
    sourcePath: string;
    destinationPath: string;
    expected?: FileDigest;
  }): Promise<
    FileDigest & {
      absolutePath: string;
      expectedIntegrityMatched: boolean | null;
    }
  >;
}
export interface ClientFailure extends Error {
  code: string;
  certainty: 'notDispatched' | 'knownFailed' | 'unknown';
  fileId?: string;
  localFileId?: string;
}
