import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ColdSessionStore } from '../../../src/integrated/session-manager/cold-storage.js';

async function createSession(root: string, sessionId: string): Promise<string> {
  const directory = join(root, 'sessions', '--E-test--', sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'session.v3.jsonl.zstd'), 'session-data');
  return directory;
}

function metadata(sessionId: string) {
  return {
    sessionId,
    title: '测试会话',
    workspacePath: 'E:/test',
    createdAt: 1,
    updatedAt: 2,
    sizeBytes: 12,
    originalRelativePath: `--E-test--/${sessionId}`,
  };
}

describe('ColdSessionStore', () => {
  it('moves an active session into archive and restores it without reading the log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cold-'));
    const sessionId = 'session-archive-1';
    try {
      const source = await createSession(root, sessionId);
      const store = new ColdSessionStore(root);
      const record = await store.move('archive', source, metadata(sessionId));

      await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(store.pathFor('archive', record))).resolves.toBeDefined();
      expect((await store.list('archive')).map((item) => item.sessionId)).toEqual([sessionId]);
      expect(JSON.parse(await readFile(join(store.archiveRoot, 'index.json'), 'utf8')).items[0].title).toBe('测试会话');

      await store.restore('archive', sessionId);
      await expect(stat(source)).resolves.toBeDefined();
      expect(await store.list('archive')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('transfers archive to trash, restores trash, and purges physically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cold-'));
    const sessionId = 'session-trash-1';
    try {
      const source = await createSession(root, sessionId);
      const store = new ColdSessionStore(root);
      const record = await store.move('archive', source, metadata(sessionId));
      const trashed = await store.transfer('archive', 'trash', sessionId);

      await expect(stat(store.pathFor('archive', record))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(trashed.source).toBe('trash');
      await expect(stat(store.pathFor('trash', trashed))).resolves.toBeDefined();
      expect(await store.list('archive')).toEqual([]);
      expect((await store.list('trash')).map((item) => item.sessionId)).toEqual([sessionId]);

      await store.restore('trash', sessionId);
      await expect(stat(source)).resolves.toBeDefined();
      expect(await store.list('trash')).toEqual([]);

      const secondSource = await createSession(root, 'session-trash-2');
      const second = await store.move('trash', secondSource, metadata('session-trash-2'));
      await store.purge('trash', second.sessionId);
      await expect(stat(store.pathFor('trash', second))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await store.list('trash')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
