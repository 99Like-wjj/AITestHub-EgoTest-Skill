import { build } from 'esbuild';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  copyFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const skill = resolve(root, 'skills/ath-web-execute');
const runtime = resolve(skill, 'scripts/runtime');
const packageInfo = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
);
await mkdir(runtime, { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/index.ts'), resolve(root, 'src/cli.ts')],
  outdir: runtime,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
});
await writeFile(
  resolve(runtime, 'index.d.mts'),
  (await readFile(resolve(root, 'src/ports.ts'), 'utf8')) +
    '\nexport interface CommandPorts { tool:ToolPort; result:ResultPort; workspace:WorkspacePort; files:FileChannelPort; privateRoot:string; principal:{actorId:string;platformOrigin:string}; }\n/** v2 default trusted-host entry. Old journals must use their preserved original package. */\nexport declare function runV2LocalCommand(ports:CommandPorts,request:unknown):Promise<unknown>;\nexport declare function runUiArchiveCommand(ports:CommandPorts,request:unknown):Promise<unknown>;\nexport declare function exportUiArchive(input:unknown):string;\n',
);
await mkdir(resolve(skill, 'contracts'), { recursive: true });
await copyFile(
  resolve(root, 'contracts/manifest.json'),
  resolve(skill, 'contracts/provenance.json'),
);
const provenance = JSON.parse(
  await readFile(resolve(root, 'contracts/manifest.json'), 'utf8'),
);
await copyFile(
  resolve(root, 'contracts', provenance.derivative.path),
  resolve(skill, 'contracts', provenance.derivative.path),
);
const v2Provenance = JSON.parse(
  await readFile(resolve(root, 'contracts/v2-provenance.json'), 'utf8'),
);
await copyFile(
  resolve(root, 'contracts/v2-provenance.json'),
  resolve(skill, 'contracts/v2-provenance.json'),
);
await copyFile(
  resolve(root, 'contracts', v2Provenance.derivative.path),
  resolve(skill, 'contracts', v2Provenance.derivative.path),
);
await copyFile(
  resolve(root, 'contracts/archive-v1.json'),
  resolve(skill, 'contracts/archive-v1.json'),
);
await copyFile(
  resolve(root, 'contracts/step-evidence-v1.json'),
  resolve(skill, 'contracts/step-evidence-v1.json'),
);
await copyFile(resolve(root, 'LICENSE'), resolve(skill, 'LICENSE'));
await mkdir(resolve(skill, 'third-party/zod'), { recursive: true });
await copyFile(
  resolve(root, 'node_modules/zod/LICENSE'),
  resolve(skill, 'third-party/zod/LICENSE'),
);
await writeFile(
  resolve(skill, 'third-party/NOTICE.md'),
  'The self-contained Node ESM bundles include Zod 4.6.7 (MIT), copyright Colin McDonnell. Its full license is in zod/LICENSE. esbuild 0.28.2 and TypeScript 6.0.3 are build tools and are not runtime dependencies. Platform JSON Schemas are derived from AITestHub MIT sources; contracts/provenance.json records their source hashes.\n',
);
async function files(path) {
  const result = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const next = resolve(path, item.name);
    if (item.isSymbolicLink())
      throw new Error('Skill bundles cannot contain symbolic links.');
    if (item.isDirectory()) result.push(...(await files(next)));
    else result.push(next);
  }
  return result;
}
const inventory = {};
const allowed = new Set([
  'LICENSE',
  'SKILL.md',
  'agents/openai.yaml',
  'manifest.json',
  'integrity.json',
  'contracts/provenance.json',
  `contracts/${provenance.derivative.path}`,
  'references/local-workflow.md',
  'references/recovery-contract.md',
  'references/ego-safety.md',
  'scripts/tool.mjs',
  'scripts/runtime/index.mjs',
  'scripts/runtime/index.d.mts',
  'scripts/runtime/cli.mjs',
  'third-party/NOTICE.md',
  'third-party/zod/LICENSE',
]);
allowed.add('contracts/v2-provenance.json');
allowed.add(`contracts/${v2Provenance.derivative.path}`);
allowed.add('references/v2-delivery.md');
allowed.add('references/independent-archives.md');
allowed.add('contracts/archive-v1.json');
allowed.add('contracts/step-evidence-v1.json');
for (const file of (await files(skill)).sort()) {
  const name = relative(skill, file).replaceAll('\\', '/');
  if (!allowed.has(name)) throw new Error(`Unexpected package entry: ${name}`);
  if (name === 'integrity.json') continue;
  inventory[name] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}
await writeFile(
  resolve(skill, 'integrity.json'),
  JSON.stringify({ algorithm: 'sha256', files: inventory }, null, 2) + '\n',
);
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(
  resolve(root, 'dist/build-inventory.json'),
  JSON.stringify(
    {
      skill: 'ath-web-execute',
      version: packageInfo.version,
      files: Object.keys(inventory).length,
      runtimeDependenciesBundled: true,
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  JSON.stringify({
    skillRoot: skill,
    files: Object.keys(inventory).length,
    bundleComplete: true,
  }) + '\n',
);
