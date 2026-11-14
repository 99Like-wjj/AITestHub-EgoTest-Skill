import type { WorkspacePort } from './ports.js';
import { invariant } from './errors.js';

/** A new release namespace, not an importer or migration for old unresolved journals. */
export class V2Workspace implements WorkspacePort {
  constructor(readonly original: WorkspacePort) {}
  private async key(key: string) {
    invariant(
      !key.startsWith('v2/'),
      'INVALID_WORKSPACE_KEY',
      'The v2 namespace is applied by the trusted adapter.',
    );
    invariant(
      (await this.original.readText(key)) === null,
      'LEGACY_JOURNAL_PRESENT',
      'A pre-v2 journal exists at this identity. Use the preserved 0.1.0 package to recover it; do not migrate, clear or resend it.',
    );
    return `v2/${key}`;
  }
  async readText(key: string) {
    return this.original.readText(await this.key(key));
  }
  async writeTextAtomic(key: string, text: string) {
    return this.original.writeTextAtomic(await this.key(key), text);
  }
  async withExclusive<T>(key: string, work: () => Promise<T>) {
    return this.original.withExclusive(await this.key(key), work);
  }
}
