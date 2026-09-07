export const packageName = 'dsh-lark-bot';

/**
 * Bare-specifier anchor row for the browser half.
 *
 * dsh's client-module scanner only reads a `dsh.client` declaration off loader
 * rows whose specifier is an exact package name: since 0.1.2-rc.1 its
 * `exactPackageSpecifier` returns undefined for anything containing a slash, so
 * every subpath row this package mounts (`dsh-lark-bot/plugin`,
 * `dsh-lark-bot/session-manager`, ...) is skipped before the manifest is ever
 * opened. Without one bare `dsh-lark-bot` row the package is never discovered,
 * its `./client` bundle stays out of `window.__DSH_BOOT__`, and the browser
 * Settings panels silently disappear while the host halves keep working.
 *
 * The host side owns no behaviour here on purpose — the row exists so the
 * scanner can resolve this manifest.
 */
export const name = 'dsh-lark-bot';

export function apply(): void {
  // Intentionally empty: see `name` above.
}
