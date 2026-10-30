import type { ColdSessionRecord, ColdStoreKind } from '../integrated/session-manager/cold-storage.js';

export interface SessionCoreItem {
  readonly sessionId: string;
  readonly title: string | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly workspacePath: string | null;
  readonly workspaceTitle: string | null;
  readonly workspaceGone: boolean;
  readonly hasWorkspace: boolean;
  readonly archived: boolean;
  readonly parentSessionId?: string;
  readonly origin?: 'subagent';
  readonly starred?: boolean;
}

export interface SessionCore {
  listActive(): Promise<SessionCoreItem[]>;
  listArchive(): Promise<ColdSessionRecord[]>;
  listTrash(): Promise<ColdSessionRecord[]>;
  archive(sessionId: string): Promise<unknown>;
  restore(sessionId: string): Promise<unknown>;
  delete(sessionId: string): Promise<unknown>;
  restoreTrash(sessionId: string): Promise<unknown>;
  purge(sessionId: string): Promise<unknown>;
  rename(sessionId: string, title: string): Promise<string>;
  readEvents(sessionId: string, fromSeq?: number): Promise<unknown[]>;
  readDetails(sessionId: string): Promise<Record<string, unknown>>;
  readExport(sessionId: string): Promise<string>;
  coldRecord(kind: ColdStoreKind, sessionId: string): Promise<ColdSessionRecord | undefined>;
}

const REGISTRY_KEY = Symbol.for('dsh-lark-bot.session-core');

function registry(): { core?: SessionCore | undefined } {
  const target = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const current = target[REGISTRY_KEY];
  if (current && typeof current === 'object') return current as { core?: SessionCore | undefined };
  const created = {};
  target[REGISTRY_KEY] = created;
  return created;
}

export function registerSessionCore(core: SessionCore): () => void {
  registry().core = core;
  return () => {
    if (registry().core === core) registry().core = undefined;
  };
}

export function getSessionCore(): SessionCore | undefined {
  return registry().core;
}
