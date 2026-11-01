// Shared reader for the DeepSeek Harness compatibility matrix.
// `src/config/dsh-compat.ts` is the single source of truth; this reader keeps
// shell-side tooling (upstream watcher, CI probe) in sync with it without
// loading TypeScript at runtime.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function readDshCompatibility() {
  const packageJson = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  );
  const source = readFileSync(join(ROOT, 'src', 'config', 'dsh-compat.ts'), 'utf8');
  const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const lockPackages = lockfile.split('\nsnapshots:\n', 1)[0];
  const get = (key) => source.match(new RegExp(`\\b${key}:\\s*'([^']+)'`))?.[1];
  // The DSH core packages are peer dependencies since the in-process rebuild:
  // the host provides them, and the plugin declares every version it supports.
  const packageSdkClient = packageJson.peerDependencies?.['@deepseek-ai/dsh-sdk-client']
    ?? packageJson.dependencies?.['@deepseek-ai/dsh-sdk-client'];
  return {
    harness: get('harness'),
    sdkClient: get('sdkClient'),
    sdkServer: get('sdkServer'),
    acp: get('acp'),
    node: get('node'),
    verifiedAt: get('verifiedAt'),
    packageSdkClient,
    packageDshTools: packageJson.dependencies?.['@deepseek-ai/dsh-tools'],
    workshopDshVersions: packageJson.dshWorkshop?.compatibility?.dshVersions,
    // Base versions (pnpm peer/hash suffixes stripped) of every DSH core
    // package actually pinned in the lockfile.
    coreLockVersions: [...new Set(
      [...lockPackages.matchAll(/^  '(@deepseek-ai\/dsh-[a-z0-9-]+)@([^']+)':$/gm)]
        .map(([, , version]) => version.split('(', 1)[0]),
    )],
  };
}

export function rootDir() {
  return ROOT;
}
