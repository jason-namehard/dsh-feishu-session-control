import { delimiter, dirname } from 'node:path';

/**
 * Produce a predictable `PATH` for a resident OS-service environment.
 *
 * The managed engine service snapshots its environment from the invoking
 * shell. `npx` prepends a private cache bin
 * (`~/.npm/_npx/<hash>/node_modules/.bin`) and `npm`/`npx` synthesise cwd-walk
 * bins (`node_modules/.bin` up the directory tree) that can pin an ephemeral
 * plugin version into a long-lived service. This removes those transient
 * entries, de-duplicates the rest, and prepends the Node binary directory so a
 * service always resolves `node`/`pnpm` from a stable location.
 *
 * Used by the managed engine environment snapshot.
 */
export function sanitizeServicePath(
  nodeBin: string,
  inheritedPath: string | undefined = process.env.PATH,
): string {
  const entries = [dirname(nodeBin), ...(inheritedPath?.split(delimiter) ?? [])];
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      if (!entry) return false;
      const normalized = entry.replaceAll('\\', '/');
      if (
        normalized.includes('/node_modules/.bin') ||
        /\/_npx(?:\/|$)/.test(normalized)
      ) {
        return false;
      }
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(delimiter);
}
