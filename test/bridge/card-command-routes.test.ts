import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = new URL('../../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Every `cmd` a card button carries must have a branch in the card-action
 * dispatcher.
 *
 * `session-alias` did not. The /delete and /purge buttons sent it, no branch
 * matched, and the handler fell off its end returning undefined — so the press
 * was logged as received and then silently discarded. Nothing threw, nothing
 * warned, and the card kept its buttons, which read as "the button is dead".
 * A missing route cannot announce itself at runtime, so it is asserted here.
 */
async function cardCommandLiterals(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const directory of ['card', 'commands']) {
    const base = join(SOURCE_ROOT, directory);
    for (const entry of await readdir(base)) {
      if (!entry.endsWith('.ts')) continue;
      const source = await readFile(join(base, entry), 'utf8');
      for (const match of source.matchAll(/cmd:\s*'([a-z-]+)'/gu)) found.add(match[1]!);
    }
  }
  return found;
}

describe('card action routing', () => {
  it('dispatches every command a card can send', async () => {
    const dispatcher = await readFile(join(SOURCE_ROOT, 'bridge', 'channel.ts'), 'utf8');
    const commands = await cardCommandLiterals();

    expect(commands.size).toBeGreaterThan(5);
    const unrouted = [...commands].filter(
      (command) => !dispatcher.includes(`cmd === '${command}'`),
    );
    expect(unrouted).toEqual([]);
    // Guard the guard: the check is only meaningful while it can still fail.
    expect(dispatcher.includes("cmd === 'no-such-card-command'")).toBe(false);
  });
});
