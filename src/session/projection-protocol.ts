import { randomUUID } from 'node:crypto';

export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  parentSessionId?: string;
  origin?: 'subagent';
  title?: string;
  trashed?: boolean;
}

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  sourceEventSeqs?: number[];
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number };
  ignorable?: true;
}

export interface DshHistoryPage {
  events: DshSessionEvent[];
  hasMore: boolean;
}

export interface SessionTrashResult {
  ok: true;
  trashed: true;
}

export interface SessionPurgeResult {
  ok: true;
  purged: true;
}

/** One decoded live session event, already narrowed to a known session. */
export interface SessionEventFrame {
  sessionId: string;
  event: DshSessionEvent;
}

/**
 * A live feed of session events, independent of how it is carried.
 *
 * The projection bridge used to consume a `WebSocket` directly, which tied it
 * to the web host's wire protocol: dsh 0.1.2-rc.1 both renamed that endpoint
 * (`/api/events.mux` -> `/api/remote.mux`) and put the whole `/api` prefix
 * behind mandatory cookie authentication that Node's built-in WebSocket cannot
 * carry. Expressing the feed as a subscription instead lets the in-process
 * host transport hand over `ctx.on('session/event', ...)` — no socket, no
 * endpoint name, no authentication — while an out-of-process transport can
 * still wrap a real socket.
 */
export interface SessionEventStream {
  /** Stop delivering frames and release the carrier. Idempotent. */
  close(): void;
  /**
   * Register the end-of-feed listener. Called at most once, and never after
   * `close()`, so the bridge can distinguish a dropped carrier (reconnect)
   * from its own shutdown.
   */
  onClose(listener: () => void): void;
}

export interface SessionProjectionSource {
  listSessions(): Promise<DshSessionSummary[]>;
  history(sessionId: string, options?: { beforeSeq?: number; maxMessages?: number }): Promise<DshHistoryPage>;
  prompt(sessionId: string, text: string, rpcId?: string): Promise<{ rpcId: string }>;
  /**
   * Begin delivering live session events to `onFrame`.
   * @param onFrame - receives every decoded frame; the bridge filters by binding.
   */
  openEvents(onFrame: (frame: SessionEventFrame) => void): Promise<SessionEventStream>;
  createSession?(cwd: string): Promise<string>;
  deleteSession?(sessionId: string): Promise<SessionTrashResult>;
  purgeSession?(sessionId: string): Promise<SessionPurgeResult>;
}

export interface WebProjectionTransport {
  rpc<T = unknown>(method: string, payload: unknown, rpcId?: string): Promise<T>;
  openMux(): Promise<WebSocket>;
  createSession?(cwd: string): Promise<string>;
  deleteSession?(sessionId: string): Promise<SessionTrashResult>;
  purgeSession?(sessionId: string): Promise<SessionPurgeResult>;
  listTrashedSessionIds?(): Promise<Set<string>>;
}

/** Adapt one raw WebSocket carrier to the transport-neutral stream contract. */
export function socketEventStream(
  socket: WebSocket,
  onFrame: (frame: SessionEventFrame) => void,
): SessionEventStream {
  let closedByUs = false;
  let endListener: (() => void) | undefined;
  socket.addEventListener('message', (frame: { data: unknown }) => {
    const decoded = decodeMuxEvent(String(frame.data));
    if (decoded) onFrame(decoded);
  });
  socket.addEventListener('close', () => {
    if (!closedByUs) endListener?.();
  }, { once: true });
  return {
    close: () => {
      closedByUs = true;
      try {
        socket.close();
      } catch {
        // the carrier is going away either way
      }
    },
    onClose: (listener) => {
      endListener = listener;
    },
  };
}

/** Typed, validation-owning facade over the rc.8 Web host session RPCs. */
export class WebSessionProjectionSource implements SessionProjectionSource {
  constructor(private readonly transport: WebProjectionTransport) {}

  async listSessions(): Promise<DshSessionSummary[]> {
    const value = responseValue(await this.transport.rpc('session.list', {}));
    if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('invalid session.list response');
    const trashedIds = this.transport.listTrashedSessionIds
      ? await this.transport.listTrashedSessionIds()
      : new Set<string>();
    return value.items.flatMap((item) => {
      if (!isRecord(item) || typeof item.sessionId !== 'string' || typeof item.updatedAt !== 'number') return [];
      const projections = isRecord(item.projections) && isRecord(item.projections.values)
        ? item.projections.values
        : undefined;
      const title = typeof projections?.title === 'string' && projections.title.trim()
        ? projections.title.trim()
        : undefined;
      const summary: DshSessionSummary = {
        sessionId: item.sessionId,
        updatedAt: item.updatedAt,
        running: item.running === true,
        blank: item.blank === true,
        ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
        ...(typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {}),
        ...(item.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        ...(title ? { title } : {}),
        ...(trashedIds.has(item.sessionId) ? { trashed: true } : {}),
      };
      return [summary];
    });
  }

  async history(
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
  ): Promise<DshHistoryPage> {
    const value = responseValue(await this.transport.rpc('session.history', {
      sessionId,
      ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
      ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    }));
    if (!isRecord(value) || !Array.isArray(value.events)) throw new Error('invalid session.history response');
    const events = value.events.flatMap((entry) => {
      const event = isRecord(entry) ? entry.event : undefined;
      return normalizeEvent(event) ? [normalizeEvent(event)!] : [];
    });
    return { events, hasMore: value.hasMore === true };
  }

  async prompt(sessionId: string, text: string, rpcId: string = randomUUID()): Promise<{ rpcId: string }> {
    responseValue(await this.transport.rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, rpcId));
    return { rpcId };
  }

  async openEvents(onFrame: (frame: SessionEventFrame) => void): Promise<SessionEventStream> {
    return socketEventStream(await this.transport.openMux(), onFrame);
  }

  async createSession(cwd: string): Promise<string> {
    if (this.transport.createSession) return this.transport.createSession(cwd);
    const value = responseValue(await this.transport.rpc('session.create', { cwd }));
    if (!isRecord(value) || typeof value.sessionId !== 'string' || !value.sessionId) {
      throw new Error('invalid session.create response');
    }
    return value.sessionId;
  }

  async deleteSession(sessionId: string): Promise<SessionTrashResult> {
    if (!this.transport.deleteSession) throw new Error('session deletion is unavailable for this adapter');
    return this.transport.deleteSession(sessionId);
  }

  async purgeSession(sessionId: string): Promise<SessionPurgeResult> {
    if (!this.transport.purgeSession) throw new Error('permanent session deletion is unavailable for this adapter');
    return this.transport.purgeSession(sessionId);
  }
}

export function decodeMuxEvent(input: unknown): { sessionId: string; event: DshSessionEvent } | undefined {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      return undefined;
    }
  }
  const payload = isRecord(parsed) && isRecord(parsed.payload) ? parsed.payload : undefined;
  if (payload?.type !== 'session/event' || typeof payload.sessionId !== 'string') return undefined;
  const event = normalizeEvent(payload.event);
  return event ? { sessionId: payload.sessionId, event } : undefined;
}

function responseValue(response: unknown): unknown {
  if (!isRecord(response) || !isRecord(response.result)) throw new Error('invalid web RPC envelope');
  if (response.result.ok !== true) {
    const error = isRecord(response.result.error) ? response.result.error : undefined;
    throw new Error(typeof error?.message === 'string' ? error.message : 'web RPC rejected');
  }
  return response.result.value;
}

function normalizeEvent(value: unknown): DshSessionEvent | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' ||
      !Number.isSafeInteger(value.seq) || (value.seq as number) < 0 ||
      typeof value.time !== 'number') return undefined;
  return {
    type: value.type,
    seq: value.seq as number,
    time: value.time,
    data: value.data,
    ...(Array.isArray(value.sourceEventSeqs)
      ? { sourceEventSeqs: value.sourceEventSeqs.filter((seq): seq is number => Number.isSafeInteger(seq)) }
      : {}),
    ...(value.surfaceOp === 'append'
      ? { surfaceOp: 'append' as const }
      : isRecord(value.surfaceOp) && value.surfaceOp.op === 'replace' &&
          Number.isSafeInteger(value.surfaceOp.start) && Number.isSafeInteger(value.surfaceOp.end)
        ? { surfaceOp: { op: 'replace' as const, start: value.surfaceOp.start as number, end: value.surfaceOp.end as number } }
        : {}),
    ...(value.ignorable === true ? { ignorable: true as const } : {}),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) =>
    isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  ).join('');
}
