import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ColdStoreKind = 'archive' | 'trash';

export interface ColdSessionRecord {
  readonly sessionId: string;
  readonly title: string | null;
  readonly workspacePath: string | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly sizeBytes: number | null;
  readonly originalRelativePath: string;
  readonly storedRelativePath: string;
  readonly movedAt: number;
  readonly source: ColdStoreKind;
  readonly parentSessionId?: string;
  readonly origin?: 'subagent';
  readonly wasArchived?: boolean;
}

interface ColdIndex {
  schemaVersion: 1;
  settings: { retentionDays: number };
  items: ColdSessionRecord[];
}

const INDEX_SCHEMA_VERSION = 1;

function normalizeIndex(raw: unknown, source: ColdStoreKind): ColdIndex {
  if (raw === null || typeof raw !== 'object') throw new Error(`invalid ${source} cold-store index`);
  const value = raw as { settings?: unknown; items?: unknown };
  const settings = value.settings && typeof value.settings === 'object'
    ? value.settings as { retentionDays?: unknown }
    : {};
  const retentionDays = Number.isInteger(settings.retentionDays) && Number(settings.retentionDays) >= 0
    ? Number(settings.retentionDays)
    : 0;
  if (value.items !== undefined && !Array.isArray(value.items)) {
    throw new Error(`invalid ${source} cold-store item index`);
  }
  const items = (value.items ?? [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => (
      typeof item.sessionId === 'string' &&
      typeof item.storedRelativePath === 'string' &&
      typeof item.originalRelativePath === 'string'
    ))
    .map((item) => ({
      sessionId: String(item.sessionId),
      title: typeof item.title === 'string' ? item.title : null,
      workspacePath: typeof item.workspacePath === 'string' ? item.workspacePath : null,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : null,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null,
      sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : null,
      originalRelativePath: ensureSafeRelativePath(String(item.originalRelativePath)),
      storedRelativePath: ensureSafeRelativePath(String(item.storedRelativePath)),
      movedAt: typeof item.movedAt === 'number' ? item.movedAt : 0,
      source,
      ...(typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {}),
      ...(item.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(typeof item.wasArchived === 'boolean' ? { wasArchived: item.wasArchived } : {}),
    }));
  const unique = new Map<string, ColdSessionRecord>();
  for (const item of items) unique.set(item.sessionId, item);
  return { schemaVersion: INDEX_SCHEMA_VERSION, settings: { retentionDays }, items: [...unique.values()] };
}

function ensureSafeRelativePath(value: string): string {
  if (!value || isAbsolute(value)) throw new Error('cold-store relative path is invalid');
  const normalized = value.replaceAll('/', sep).replaceAll('\\', sep);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`)) {
    throw new Error('cold-store path escapes its root');
  }
  return normalized;
}

function inside(root: string, target: string): boolean {
  const rootAbs = resolve(root).toLowerCase();
  const targetAbs = resolve(target).toLowerCase();
  return targetAbs === rootAbs || targetAbs.startsWith(`${rootAbs}${sep}`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export class ColdSessionStore {
  readonly archiveRoot: string;
  readonly trashRoot: string;
  private readonly sessionsRoot: string;
  private mutation = Promise.resolve();

  constructor(dshHome: string) {
    this.sessionsRoot = resolve(join(dshHome, 'sessions'));
    this.archiveRoot = resolve(join(dshHome, 'sessions-archive'));
    this.trashRoot = resolve(join(dshHome, 'sessions-trash'));
  }

  root(kind: ColdStoreKind): string {
    return kind === 'archive' ? this.archiveRoot : this.trashRoot;
  }

  private indexPath(kind: ColdStoreKind): string {
    return join(this.root(kind), 'index.json');
  }

  private async readIndex(kind: ColdStoreKind): Promise<ColdIndex> {
    try {
      return normalizeIndex(JSON.parse(await readFile(this.indexPath(kind), 'utf8')), kind);
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: INDEX_SCHEMA_VERSION, settings: { retentionDays: 0 }, items: [] };
      throw error;
    }
  }

  private async writeIndex(kind: ColdStoreKind, index: ColdIndex): Promise<void> {
    const root = this.root(kind);
    await mkdir(root, { recursive: true });
    const temp = join(root, `.index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(normalizeIndex(index, kind), null, 2), 'utf8');
      await rename(temp, this.indexPath(kind));
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async updateIndex(kind: ColdStoreKind, update: (index: ColdIndex) => ColdIndex): Promise<void> {
    const index = await this.readIndex(kind);
    await this.writeIndex(kind, update(index));
  }

  async list(kind: ColdStoreKind): Promise<ColdSessionRecord[]> {
    const items = (await this.readIndex(kind)).items;
    return [...items].sort((left, right) => right.movedAt - left.movedAt);
  }

  async find(kind: ColdStoreKind, sessionId: string): Promise<ColdSessionRecord | undefined> {
    return (await this.readIndex(kind)).items.find((item) => item.sessionId === sessionId);
  }

  async settings(kind: ColdStoreKind): Promise<{ retentionDays: number }> {
    return { ...(await this.readIndex(kind)).settings };
  }

  async setSettings(kind: ColdStoreKind, settings: { retentionDays: number }): Promise<{ retentionDays: number }> {
    return this.serialize(async () => {
      if (!Number.isInteger(settings.retentionDays) || settings.retentionDays < 0) {
        throw new Error('cold-store retention must be a non-negative integer');
      }
      await this.updateIndex(kind, (index) => ({ ...index, settings: { retentionDays: settings.retentionDays } }));
      return { retentionDays: settings.retentionDays };
    });
  }

  pathFor(kind: ColdStoreKind, record: Pick<ColdSessionRecord, 'storedRelativePath'>): string {
    const path = join(this.root(kind), ensureSafeRelativePath(record.storedRelativePath));
    if (!inside(this.root(kind), path)) throw new Error('cold-store path escapes its root');
    return path;
  }

  async move(
    kind: ColdStoreKind,
    sourceDirectory: string,
    metadata: Omit<ColdSessionRecord, 'storedRelativePath' | 'movedAt' | 'source'>,
  ): Promise<ColdSessionRecord> {
    return this.serialize(async () => {
      const source = await this.assertSourceDirectory(sourceDirectory, metadata.sessionId);
      const originalRelativePath = ensureSafeRelativePath(relative(this.sessionsRoot, source));
      const storedRelativePath = ensureSafeRelativePath(join(basename(dirname(source)), basename(source)));
      const destination = this.pathFor(kind, { storedRelativePath });
      const existing = await this.find(kind, metadata.sessionId);
      if (existing && await exists(this.pathFor(kind, existing))) return existing;
      await mkdir(dirname(destination), { recursive: true });
      if (await exists(destination)) throw new Error(`cold-store destination already exists: ${metadata.sessionId}`);

      await rename(source, destination);
      const record: ColdSessionRecord = {
        ...metadata,
        originalRelativePath,
        storedRelativePath,
        movedAt: Date.now(),
        source: kind,
      };
      try {
        await this.updateIndex(kind, (index) => ({
          ...index,
          items: [...index.items.filter((item) => item.sessionId !== record.sessionId), record],
        }));
      } catch (error) {
        await rename(destination, source).catch(() => undefined);
        throw error;
      }
      return record;
    });
  }

  async restore(kind: ColdStoreKind, sessionId: string): Promise<ColdSessionRecord> {
    return this.serialize(async () => {
      const index = await this.readIndex(kind);
      const record = index.items.find((item) => item.sessionId === sessionId);
      if (!record) throw new Error('session was not found in cold storage');
      const source = this.pathFor(kind, record);
      const destination = join(this.sessionsRoot, ensureSafeRelativePath(record.originalRelativePath));
      if (!inside(this.sessionsRoot, destination)) throw new Error('restore path escapes the sessions root');
      if (!(await exists(source))) throw new Error('cold-storage session files are missing');
      if (await exists(destination)) throw new Error('the original active session directory already exists');
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
      try {
        await this.writeIndex(kind, { ...index, items: index.items.filter((item) => item.sessionId !== sessionId) });
      } catch (error) {
        await rename(destination, source).catch(() => undefined);
        throw error;
      }
      return record;
    });
  }

  async transfer(from: ColdStoreKind, to: ColdStoreKind, sessionId: string): Promise<ColdSessionRecord> {
    return this.serialize(async () => {
      if (from === to) throw new Error('cold-storage transfer needs two different stores');
      const fromIndex = await this.readIndex(from);
      const record = fromIndex.items.find((item) => item.sessionId === sessionId);
      if (!record) throw new Error('session was not found in cold storage');
      const source = this.pathFor(from, record);
      const destination = this.pathFor(to, record);
      if (!(await exists(source))) throw new Error('cold-storage session files are missing');
      if (await exists(destination)) throw new Error('the destination cold store already contains this session');
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
      const next: ColdSessionRecord = { ...record, source: to, movedAt: Date.now() };
      const toIndex = await this.readIndex(to);
      try {
        await this.writeIndex(to, {
          ...toIndex,
          items: [...toIndex.items.filter((item) => item.sessionId !== sessionId), next],
        });
        await this.writeIndex(from, {
          ...fromIndex,
          items: fromIndex.items.filter((item) => item.sessionId !== sessionId),
        });
      } catch (error) {
        await this.writeIndex(to, toIndex).catch(() => undefined);
        await this.writeIndex(from, fromIndex).catch(() => undefined);
        await rename(destination, source).catch(() => undefined);
        throw error;
      }
      return next;
    });
  }

  async purge(kind: ColdStoreKind, sessionId: string): Promise<ColdSessionRecord> {
    return this.serialize(async () => {
      const index = await this.readIndex(kind);
      const record = index.items.find((item) => item.sessionId === sessionId);
      if (!record) throw new Error('session was not found in cold storage');
      const target = this.pathFor(kind, record);
      if (await exists(target)) await rm(target, { recursive: true, force: false });
      await this.writeIndex(kind, { ...index, items: index.items.filter((item) => item.sessionId !== sessionId) });
      return record;
    });
  }

  private async assertSourceDirectory(sourceDirectory: string, sessionId: string): Promise<string> {
    const source = await stat(sourceDirectory)
      .then((item) => item.isDirectory() ? resolve(sourceDirectory) : dirname(resolve(sourceDirectory)))
      .catch(() => '');
    if (!source || !inside(this.sessionsRoot, source) || source === this.sessionsRoot) {
      throw new Error('active session directory is invalid');
    }
    const identity = sessionId.replace(/^session-/, '');
    if (!basename(source).includes(identity)) throw new Error('session directory does not match sessionId');
    return source;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation);
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}
