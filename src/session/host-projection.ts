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
  /**
   * Provider/model for sessions this source creates. dsh resolves prompt
   * variables such as `{{model}}` from the agent's own options, so a session
   * created without a route fails prompt assembly on its first turn.
   */
  provider?: string;
  model?: string;
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

  /**
   * The session list, read from this bridge's own `/archived-sessions/sessions`
   * route rather than assembled here.
   *
   * That route is what the browser Settings panels already use, so Feishu and
   * the Web UI show the same name for the same session — which is the point:
   * a list of opaque ids is unusable for picking a conversation on a phone.
   * It also carries `workspacePath`, and the chooser matches a session to the
   * chat by exact cwd; the persistence headers alone do not always have one,
   * and a session with no cwd silently becomes unselectable, which is how
   * /use, /delete and /purge all came to fail.
   */
  async listSessions(): Promise<DshSessionSummary[]> {
    const [items, trashed] = await Promise.all([
      this.fetchSessionItems(),
      this.listTrashedSessionIds(),
    ]);
    const live = this.services.liveSessionIds();
    return items
      .map((item) => {
        const sessionId = typeof item.sessionId === 'string' ? item.sessionId : undefined;
        if (sessionId === undefined) return undefined;
        const title = typeof item.title === 'string' && item.title.trim() !== ''
          ? item.title.trim()
          : undefined;
        const cwd = typeof item.workspacePath === 'string' ? item.workspacePath : undefined;
        const updatedAt = typeof item.updatedAt === 'number'
          ? item.updatedAt
          : typeof item.createdAt === 'number' ? item.createdAt : 0;
        const summary: DshSessionSummary = {
          sessionId,
          updatedAt,
          running: live.has(sessionId),
          // Untitled and never used: a shell the chooser should not offer.
          blank: title === undefined && updatedAt === 0,
          ...(cwd === undefined ? {} : { cwd }),
          ...(title === undefined ? {} : { title }),
          ...(trashed.has(sessionId) ? { trashed: true } : {}),
        };
        return summary;
      })
      .filter((summary): summary is DshSessionSummary => summary !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async fetchSessionItems(): Promise<Array<Record<string, unknown>>> {
    const response = await fetch(`${this.endpoints.baseUrl}/archived-sessions/sessions`, {
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as { items?: unknown };
    if (!response.ok || !Array.isArray(body.items)) {
      throw new Error(`session listing failed: HTTP ${response.status}`);
    }
    return body.items as Array<Record<string, unknown>>;
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
    const agent = await this.services.agentFor(sessionId, {
      ...(this.endpoints.provider === undefined ? {} : { provider: this.endpoints.provider }),
      ...(this.endpoints.model === undefined ? {} : { model: this.endpoints.model }),
    });
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
      {
        ...(this.endpoints.provider === undefined ? {} : { provider: this.endpoints.provider }),
        ...(this.endpoints.model === undefined ? {} : { model: this.endpoints.model }),
      },
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
