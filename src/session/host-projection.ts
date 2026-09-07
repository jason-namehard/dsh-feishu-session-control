import { randomUUID } from 'node:crypto';
import type { HostServices, HostSessionEvent } from '../adapters/dsh/host-services.js';
import { log } from '../core/logger.js';
import type {
  DshHistoryPage,
  DshSessionEvent,
  DshSessionSummary,
  SessionEventFrame,
  SessionEventStream,
  SessionProjectionSource,
  SessionPurgeResult,
  SessionTrashResult,
} from './projection-protocol.js';

/**
 * Endpoints this bridge registers on the host web server itself, outside the
 * `/api` prefix and therefore outside dsh's browser-authentication fence.
 * They stay reachable over plain loopback HTTP on 0.1.2-rc.1, which is why the
 * recycle-bin operations keep using them instead of being reimplemented here:
 * the trash index, its durable tombstones and the path-safety checks all live
 * in one place (`src/integrated/session-manager`).
 */
export interface HostProjectionEndpoints {
  baseUrl: string;
}

function asDshEvent(event: HostSessionEvent): DshSessionEvent | undefined {
  if (typeof event.type !== 'string' || typeof event.seq !== 'number') return undefined;
  return {
    type: event.type,
    seq: event.seq,
    time: typeof event.time === 'number' ? event.time : 0,
    data: event.data,
  };
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  if (!response.ok || typeof parsed !== 'object' || parsed === null) {
    throw new Error(`HTTP ${response.status}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * In-process session projection: everything the Feishu session commands need,
 * read straight from the host services rather than over its HTTP API.
 *
 * `WebSessionProjectionSource` speaks the web host's wire protocol, all three
 * layers of which moved in 0.1.2-rc.1 (mandatory `/api` authentication,
 * `session.list` -> `session/list`, `events.mux` -> `remote.mux`). Running as a
 * plugin inside dsh, none of that is necessary: the session list is the
 * persistence layer's own header list, history is a log read, and the live feed
 * is the `session/event` bus.
 *
 * The recycle-bin operations are the deliberate exception — see
 * {@link HostProjectionEndpoints}.
 */
export class HostSessionProjectionSource implements SessionProjectionSource {
  constructor(
    private readonly services: HostServices,
    private readonly endpoints: HostProjectionEndpoints,
  ) {}

  async listSessions(): Promise<DshSessionSummary[]> {
    const [headers, trashed] = await Promise.all([
      this.services.sessionHeaders(),
      this.listTrashedSessionIds(),
    ]);
    const live = this.services.liveSessionIds();
    const summaries = await Promise.all(headers.map(async (header) => {
      const sessionId = String(header.id);
      const cwd = header.cwd ?? header.meta?.cwd;
      const title = header.title?.trim() || (await this.services.sessionTitle(sessionId));
      const updatedAt = header.updatedAt ?? header.createdAt ?? header.meta?.createdAt ?? 0;
      const summary: DshSessionSummary = {
        sessionId,
        updatedAt,
        running: live.has(sessionId),
        // A session with no title and no recorded work is a blank shell the
        // chooser should not offer as a resumable conversation.
        blank: title === undefined && updatedAt === 0,
        ...(cwd === undefined ? {} : { cwd }),
        ...(title === undefined ? {} : { title }),
        ...(trashed.has(sessionId) ? { trashed: true } : {}),
      };
      return summary;
    }));
    // Newest first: the chooser and the aliases both read better that way.
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async history(
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
  ): Promise<DshHistoryPage> {
    const page = await this.services.readSessionLog(sessionId, 0);
    const all = (page.events ?? [])
      .map(asDshEvent)
      .filter((event): event is DshSessionEvent => event !== undefined);
    const eligible = options.beforeSeq === undefined
      ? all
      : all.filter((event) => event.seq < options.beforeSeq!);
    const selected = options.maxMessages === undefined
      ? eligible
      : eligible.slice(-options.maxMessages);
    return { events: selected, hasMore: selected.length < eligible.length };
  }

  async prompt(sessionId: string, text: string, rpcId: string = randomUUID()): Promise<{ rpcId: string }> {
    const agent = await this.services.agentFor(sessionId);
    if (!agent) throw new Error(`session ${sessionId} could not be resumed`);
    agent.followup(await this.services.userMessage(text));
    return { rpcId };
  }

  async openEvents(onFrame: (frame: SessionEventFrame) => void): Promise<SessionEventStream> {
    const unsubscribe = this.services.onSessionEvent((sessionId, event) => {
      const decoded = asDshEvent(event);
      if (decoded) onFrame({ sessionId, event: decoded });
    });
    if (!unsubscribe) throw new Error('dsh host context exposes no session event bus');
    return {
      close: () => unsubscribe(),
      // An in-process feed has no carrier that can drop: it ends only when we
      // end it. The end listener therefore intentionally never fires, so the
      // bridge never schedules a reconnect against its own event bus.
      onClose: () => undefined,
    };
  }

  async createSession(cwd: string): Promise<string> {
    const agent = await this.services.createAgent(
      await this.services.sessionId(`session-${randomUUID()}`),
      cwd,
    );
    return agent.id;
  }

  async deleteSession(sessionId: string): Promise<SessionTrashResult> {
    const body = await postJson(
      `${this.endpoints.baseUrl}/__chameleon/session/delete`,
      { sessionId },
    );
    if (body.ok !== true) {
      throw new Error(typeof body.error === 'string' ? body.error : 'session deletion failed');
    }
    return body as unknown as SessionTrashResult;
  }

  async purgeSession(sessionId: string): Promise<SessionPurgeResult> {
    const body = await postJson(
      `${this.endpoints.baseUrl}/__chameleon/session/purge`,
      { sessionId },
    );
    if (body.ok !== true) {
      throw new Error(
        typeof body.error === 'string' ? body.error : 'permanent session deletion failed',
      );
    }
    return body as unknown as SessionPurgeResult;
  }

  /**
   * Session ids currently in the recycle bin, so `/sessions` can mark them and
   * `/use` can refuse them.
   *
   * A recycle bin that cannot be read must not blank out the session list: an
   * unreadable bin is reported as empty, which at worst omits the trashed
   * marker, while propagating would break listing entirely.
   */
  private async listTrashedSessionIds(): Promise<Set<string>> {
    try {
      const response = await fetch(`${this.endpoints.baseUrl}/archived-sessions/trash/list`, {
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json()) as { items?: Array<{ sessionId?: unknown }> };
      if (!response.ok || !Array.isArray(body.items)) return new Set();
      return new Set(
        body.items
          .map((item) => (typeof item?.sessionId === 'string' ? item.sessionId : undefined))
          .filter((id): id is string => id !== undefined),
      );
    } catch (error) {
      log.warn('session-projection', 'trash-list-unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Set();
    }
  }
}
