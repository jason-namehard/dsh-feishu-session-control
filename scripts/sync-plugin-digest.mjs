/**
 * Keep `dsh-plugin.json`'s `artifact.digest` in step with the build it describes.
 *
 * The manifest declares the fingerprint of its own artifact, but `build` only
 * writes `dist/` — nothing recomputed the digest, so it drifted on every build
 * and had to be corrected by hand. That is a silent failure: nothing in dsh
 * reads the field, so a stale digest never stops the plugin loading, which is
 * exactly why it went unnoticed.
 *
 * Run from `postbuild`, and therefore by every `pnpm build` / `npm run build`,
 * so a contributor cannot forget it. It is deliberately not part of `build`
 * itself: a build that produced `dist/` did its job even if this step cannot
 * run, and failing the build over metadata would be the wrong trade.
 *
 * The rewrite is a single-value substitution rather than a re-serialization, so
 * the manifest's own formatting survives and the diff stays one line.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'dsh-plugin.json');

/** The single quoted `"digest": "sha256:…"` value in the manifest. */
const DIGEST_LINE = /("digest"\s*:\s*")([^"]*)(")/u;

const manifest = await readText(manifestPath);
// A manifest an editor saved with a UTF-8 BOM is still valid JSON to every
// reader that strips it, and `JSON.parse` is not one of them — it reports the
// BOM as an unexpected token. Read through it rather than rejecting the file.
const artifactPath = join(
  root,
  JSON.parse(manifest.replace(/^\uFEFF/u, '')).artifact?.path ?? 'dist/plugin.js',
);
const digest = `sha256:${createHash('sha256').update(await readFile(artifactPath)).digest('hex')}`;

const current = DIGEST_LINE.exec(manifest)?.[2];
if (current === digest) {
  console.log(`dsh-plugin.json digest is current (${digest})`);
} else {
  await writeFile(manifestPath, manifest.replace(DIGEST_LINE, `$1${digest}$3`), 'utf8');
  console.log(`dsh-plugin.json digest ${current ?? '(missing)'} -> ${digest}`);
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    console.error(`sync-plugin-digest: cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
}
