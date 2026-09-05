import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write.js';
import { log } from '../core/logger.js';

export interface AliasMap {
  [alias: string]: string;
}

export interface AliasSessionCandidate {
  sessionId: string;
  updatedAt?: number;
}

const ALIAS_RE = /^(\d{4})-(\d+)$/u;

export function aliasDate(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}${day}`;
}

export function generateAlias(aliases: AliasMap, date: Date = new Date()): string {
  const datePrefix = aliasDate(date);
  const pattern = new RegExp(`^${datePrefix}-(\\d+)$`, 'u');
  let maxNumber = 0;
  for (const alias of Object.keys(aliases)) {
    const match = pattern.exec(alias);
    if (match) maxNumber = Math.max(maxNumber, Number.parseInt(match[1]!, 10));
  }
  return `${datePrefix}-${String(maxNumber + 1)}`;
}

export class SessionAliasManager {
  private aliases: AliasMap = {};
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.aliases = normalizeAliases(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.aliases = {};
    }
    this.loaded = true;
  }

  get path(): string {
    return this.filePath;
  }

  getSessionId(alias: string): string | undefined {
    return this.aliases[alias.trim()];
  }

  entries(): Array<{ alias: string; sessionId: string }> {
    return Object.entries(this.aliases)
      .map(([alias, sessionId]) => ({ alias, sessionId }))
      .sort((left, right) => left.alias.localeCompare(right.alias, 'en', { numeric: true }));
  }

  async registerSession(sessionId: string, date: Date = this.clock()): Promise<string> {
    const normalizedId = sessionId.trim();
    if (!normalizedId) throw new Error('session id is required');
    return this.mutate((aliases) => {
      const existing = Object.entries(aliases).find(([, id]) => id === normalizedId)?.[0];
      if (existing) return existing;
      const alias = generateAlias(aliases, date);
      aliases[alias] = normalizedId;
      return alias;
    });
  }

  async removeAlias(alias: string): Promise<boolean> {
    return this.mutate((aliases) => {
      const normalized = alias.trim();
      if (!(normalized in aliases)) return false;
      delete aliases[normalized];
      return true;
    });
  }

  async syncSessions(candidates: readonly AliasSessionCandidate[]): Promise<void> {
    const unique = new Map<string, AliasSessionCandidate>();
    for (const candidate of candidates) {
      const sessionId = candidate.sessionId.trim();
      if (!sessionId || unique.has(sessionId)) continue;
      unique.set(sessionId, { ...candidate, sessionId });
    }
    await this.mutate((aliases) => {
      const liveIds = new Set(unique.keys());
      for (const alias of Object.keys(aliases)) {
        if (!liveIds.has(aliases[alias]!)) delete aliases[alias];
      }
      const missing = [...unique.values()]
        .filter((candidate) => !Object.values(aliases).includes(candidate.sessionId))
        .sort((left, right) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0) || left.sessionId.localeCompare(right.sessionId));
      for (const candidate of missing) {
        const date = candidate.updatedAt !== undefined && Number.isFinite(candidate.updatedAt) && candidate.updatedAt > 0
          ? new Date(candidate.updatedAt)
          : this.clock();
        aliases[generateAlias(aliases, date)] = candidate.sessionId;
      }
    });
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private async mutate<T>(mutation: (aliases: AliasMap) => T): Promise<T> {
    let result!: T;
    const operation = this.saving.then(async () => {
      if (!this.loaded) await this.load();
      const next = { ...this.aliases };
      result = mutation(next);
      this.aliases = next;
      await writeFileAtomic(this.filePath, `${JSON.stringify(this.aliases, null, 2)}\n`, { mode: 0o600 });
    });
    this.saving = operation.catch((error: unknown) => {
      log.fail('session-aliases', error, { step: 'persist', path: this.filePath });
    });
    await operation;
    return result;
  }
}

function normalizeAliases(value: unknown): AliasMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const aliases: AliasMap = {};
  for (const [rawAlias, rawSessionId] of Object.entries(value)) {
    const alias = rawAlias.trim();
    if (!ALIAS_RE.test(alias) || typeof rawSessionId !== 'string' || !rawSessionId.trim()) continue;
    aliases[alias] = rawSessionId.trim();
  }
  return aliases;
}
