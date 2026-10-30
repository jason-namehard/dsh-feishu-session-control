export interface SessionHeaderRecord {
  readonly id?: unknown;
  readonly cwd?: unknown;
  readonly title?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly parentSession?: unknown;
  readonly origin?: unknown;
  readonly delegationDepth?: unknown;
  readonly meta?: unknown;
  readonly [key: string]: unknown;
}

export interface SessionSnapshotRecord {
  readonly header?: unknown;
  readonly [key: string]: unknown;
}

export function unwrapSessionHeader(value: unknown): SessionHeaderRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as SessionSnapshotRecord;
  if (candidate.header && typeof candidate.header === 'object') {
    return candidate.header as SessionHeaderRecord;
  }
  return value as SessionHeaderRecord;
}

export function sessionIdOf(value: unknown): string | undefined {
  const header = unwrapSessionHeader(value);
  return typeof header?.id === 'string' && header.id.length > 0 ? header.id : undefined;
}

export function sessionHeaderList(values: readonly unknown[]): SessionHeaderRecord[] {
  const headers: SessionHeaderRecord[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const header = unwrapSessionHeader(value);
    const id = sessionIdOf(header);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (header) headers.push(header);
  }
  return headers;
}

export function stringField(value: unknown, key: string): string | undefined {
  const field = unwrapSessionHeader(value)?.[key];
  return typeof field === 'string' && field.trim() !== '' ? field : undefined;
}

export function numberField(value: unknown, key: string): number | undefined {
  const field = unwrapSessionHeader(value)?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
