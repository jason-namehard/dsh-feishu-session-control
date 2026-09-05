import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionAliasManager, generateAlias } from '../../src/session/alias-manager.js';

describe('SessionAliasManager', () => {
  it('allocates stable daily aliases without renumbering survivors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-alias-'));
    const file = join(root, '.session_aliases.json');
    const date = new Date(2026, 8, 5, 12, 0, 0);
    const manager = new SessionAliasManager(file, () => date);

    expect(await manager.registerSession('s1')).toBe('0905-1');
    expect(await manager.registerSession('s2')).toBe('0905-2');
    expect(await manager.registerSession('s3')).toBe('0905-3');
    expect(await manager.removeAlias('0905-1')).toBe(true);
    expect(await manager.registerSession('s4')).toBe('0905-4');
    expect(manager.getSessionId('0905-2')).toBe('s2');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      '0905-2': 's2',
      '0905-3': 's3',
      '0905-4': 's4',
    });
  });

  it('backfills aliases from session dates and removes stale mappings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-alias-sync-'));
    const manager = new SessionAliasManager(join(root, '.session_aliases.json'), () => new Date(2026, 8, 5));

    await manager.registerSession('stale');
    await manager.syncSessions([
      { sessionId: 'old', updatedAt: new Date(2026, 8, 3).getTime() },
      { sessionId: 'new', updatedAt: new Date(2026, 8, 5).getTime() },
    ]);

    expect(manager.entries()).toEqual([
      { alias: '0903-1', sessionId: 'old' },
      { alias: '0905-1', sessionId: 'new' },
    ]);
    expect(manager.getSessionId('0905-1')).toBe('new');
  });

  it('keeps generated aliases unique during concurrent registration', async () => {
    const aliases = { '0905-1': 'existing' };
    expect(generateAlias(aliases, new Date(2026, 8, 5))).toBe('0905-2');
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-alias-concurrent-'));
    const manager = new SessionAliasManager(join(root, '.session_aliases.json'), () => new Date(2026, 8, 5));
    const allocated = await Promise.all(['a', 'b', 'c'].map((id) => manager.registerSession(id)));
    expect(new Set(allocated).size).toBe(3);
    expect(manager.entries().map((entry) => entry.alias)).toEqual(['0905-1', '0905-2', '0905-3']);
  });
});
