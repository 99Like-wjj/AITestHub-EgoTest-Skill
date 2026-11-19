import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { parseJson, bytesHash, assertNoSecrets } from './canonical.js';
import { scope, submissionSchema } from './contracts.js';
import { LocalError, invariant } from './errors.js';
import { readV2, type ResultBatch } from './v2-contracts.js';
import { exportUiArchive } from './archives.js';
import { assertBatchBudget } from './v2-planner.js';

export async function toolInfo(skillRoot: string) {
  const manifest = parseJson(
    await readFile(resolve(skillRoot, 'manifest.json'), 'utf8'),
  );
  const integrity = parseJson(
    await readFile(resolve(skillRoot, 'integrity.json'), 'utf8'),
  ) as { files: Record<string, string> };
  invariant(
    integrity && typeof integrity.files === 'object',
    'INVALID_MANIFEST',
    'Missing package integrity list.',
  );
  const checks = [];
  for (const [name, expected] of Object.entries(integrity.files)) {
    const path = resolve(skillRoot, name),
      rel = relative(skillRoot, path);
    invariant(
      !isAbsolute(rel) && !rel.startsWith('..'),
      'INVALID_MANIFEST',
      'Package entry escaped the Skill directory.',
    );
    try {
      checks.push({
        path: name,
        matches: bytesHash(await readFile(path)) === expected,
      });
    } catch {
      checks.push({ path: name, matches: false });
    }
  }
  const actual: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      invariant(
        !entry.isSymbolicLink(),
        'INVALID_MANIFEST',
        'Package contains a symbolic link.',
      );
      if (entry.isDirectory()) await walk(child);
      else actual.push(relative(skillRoot, child).replaceAll('\\', '/'));
    }
  }
  await walk(skillRoot);
  const unexpected = actual.filter(
    (x) => x !== 'integrity.json' && !(x in integrity.files),
  );
  return {
    manifest,
    integrity: {
      valid:
        checks.length > 0 &&
        checks.every((x) => x.matches) &&
        unexpected.length === 0,
      checks,
      unexpected,
    },
    runtime: {
      node: process.version,
      nodeMatchesPinnedRuntime: process.version === 'v24.19.0',
      liveConnectionVerified: false,
      egoExecutionVerified: false,
      installedOrLoadedNotInferred: true,
    },
  };
}
export async function main(
  args: string[],
  skillRoot = resolve(fileURLToPath(new URL('../..', import.meta.url))),
): Promise<void> {
  const command = args[0];
  if (command === 'tool-info') {
    process.stdout.write(
      JSON.stringify(await toolInfo(skillRoot), null, 2) + '\n',
    );
    return;
  }
  if (command === 'validate-archive') {
    invariant(
      args.length === 2,
      'ARGUMENTS',
      'Supply one explicitly selected archive JSON.',
    );
    exportUiArchive(parseJson(await readFile(resolve(args[1]!), 'utf8')));
    process.stdout.write(
      JSON.stringify({
        valid: true,
        schemaVersion: 'ath.ui-archive.v1',
        validationOnly: true,
      }) + '\n',
    );
    return;
  }
  invariant(
    ['validate-scope', 'validate-submission', 'validate-batch'].includes(
      command ?? '',
    ),
    'HOST_BINDING_REQUIRED',
    'Use offline validation or the trusted host calling runV2LocalCommand with injected ports.',
  );
  invariant(
    args.length === 2,
    'ARGUMENTS',
    'Supply exactly one explicitly selected JSON file.',
  );
  const value = parseJson(await readFile(resolve(args[1]!), 'utf8'));
  assertNoSecrets(value);
  const checked =
    command === 'validate-scope'
      ? scope(value)
      : command === 'validate-batch'
        ? readV2<ResultBatch>('uiResultBatchSchema', value)
        : submissionSchema.parse(value);
  if (command === 'validate-batch') assertBatchBudget(checked as ResultBatch);
  process.stdout.write(
    JSON.stringify({
      valid: true,
      runId: checked.runId,
      items: checked.items.length,
      schemaVersion: checked.schemaVersion,
      validationOnly: true,
    }) + '\n',
  );
}
export async function runCli(args: string[], skillRoot?: string) {
  try {
    await main(args, skillRoot);
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: error instanceof LocalError ? error.code : 'VALIDATION_FAILED',
          message:
            error instanceof LocalError
              ? error.message
              : 'Input validation failed; source values omitted.',
        },
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
