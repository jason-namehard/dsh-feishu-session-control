/**
 * The single point of contact with dsh's in-process host services.
 *
 * Everything this bridge needs from the running Harness — creating and
 * resuming agents, driving a turn, cancelling one, reading the session log,
 * subscribing to live events — is reached through the cordis context the
 * plugin is mounted on, never over loopback HTTP.
 *
 * Calling the local web server from a plugin that runs *inside* that same
 * process was the root cause of every transport break in the 0.1.2-rc.1
 * upgrade: the `/api` prefix grew mandatory cookie authentication, the RPC
 * names moved from `session.create` to `session/create`, and the event mux was
 * renamed. None of that applies to a direct service call.
 *
 * Structural knowledge of dsh's service shapes is deliberately confined to
 * this file so a future upstream rename is a single-file fix. The types are
 * declared locally and narrowed at runtime rather than imported, because the
 * bridge must also load on hosts that do not provide these services at all
 * (the standalone CLI, the SDK/ACP adapters, and tests).
 *
 * Every shape here was verified against a live 0.1.2-rc.1 host in an isolated
 * DSH_HOME: `ctx.get('agents')` exposing create/resume/get/list,
 * `ctx.on('session/event')` returning an unsubscribe function, and a real
 * `create -> followup -> dispose` round trip on a throwaway session.
 */

import { sessionHeaderList } from '../../session/session-metadata.js';
import { getSessionCore, type SessionCore } from '../../session-core/index.js';

/** dsh's branded session identity; a plain string on the wire. */
export type HostSessionId = string;

/** One durable session-log event, as `session/event` delivers it. */
export interface HostSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly data?: unknown;
}

/** The live session an agent drives; its log is the source of truth. */
export interface HostSession {
  readonly id: HostSessionId;
  readonly meta?: { readonly cwd?: string };
}

/**
 * The subset of dsh's live `Agent` this bridge drives.
 *
 * `followup` is the ordinary prompt entry point: it queues the message as the
 * sole ordinary message of its own turn and wakes the driver.
 */
export interface HostAgent {
  readonly id: HostSessionId;
  readonly session: HostSession;
  /** Lifecycle state; dsh 0.1.2-rc.1 reports a plain string such as `'idle'`. */
  readonly status?: unknown;
  followup(message: unknown): void;
  cancel(cause: { readonly kind: 'user' }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

/**
 * One persisted session header as `sessionPersistence.list()` returns it.
 *
 * The delegation fields are written into the header itself, so a caller can
 * tell a top-level conversation from an ephemeral child without reading a log.
 */
export interface HostSessionHeader {
  readonly id: HostSessionId;
  readonly cwd?: string;
  readonly title?: string;
  readonly updatedAt?: number;
  readonly createdAt?: number;
  /** Session that delegated this one; absent for a top-level session. */
  readonly parentSession?: string;
  /** `'subagent'` for a delegated child; absent for a top-level session. */
  readonly origin?: string;
  /** Delegation depth: 0 for a top-level session, above 0 for a child. */
  readonly delegationDepth?: number;
  readonly meta?: { readonly cwd?: string; readonly createdAt?: number; readonly title?: string };
}

/**
 * Whether a persisted header describes a subagent (child) session.
 *
 * A delegated child carries `origin: 'subagent'`, a `parentSession` and a
 * `delegationDepth` above zero; a top-level session has none of the three. The
 * signal has to come from here: the id shape says nothing — historical
 * top-level sessions exist whose ids are bare uuids rather than the current
 * `session-<uuid>` form — and the Web session listing route carries no
 * delegation metadata at all.
 *
 * @param header - one header as `sessionPersistence.list()` returns it.
 * @returns true when the session is a delegated child.
 */
export function isSubagentSessionHeader(header: HostSessionHeader): boolean {
  return header.origin === 'subagent' ||
    header.parentSession !== undefined ||
    (header.delegationDepth ?? 0) > 0;
}

/** One page of a session log returned by a persistence handle. */
export interface HostSessionLog {
  readonly meta?: { readonly cwd?: string; readonly createdAt?: number };
  readonly events?: readonly HostSessionEvent[];
}

interface HostSessionPersistence {
  list(): Promise<readonly unknown[]>;
  open?(id: HostSessionId, access: 'read' | 'write'): Promise<HostSessionHandle>;
  readFrom?(id: HostSessionId, fromSeq: number): Promise<HostSessionLog>;
}

interface HostSessionHandle {
  readonly header?: HostSessionLog['meta'];
  read(offset?: number): Promise<HostSessionLog>;
  close(): Promise<void>;
}

interface HostSessionQuery {
  readTitleSnapshot?(id: HostSessionId): Promise<{ title?: string } | undefined>;
}

/**
 * dsh's own title service (`@deepseek-ai/dsh-session-title`), the single
 * writer for a session's user-chosen name. `rename` appends a durable title
 * event to the session log, which is what every other surface reads — so a
 * name set from Feishu shows up in the Web UI without any syncing of our own.
 * It takes the session object, not its id, exactly as dsh's own session
 * controller calls it.
 */
interface HostSessionTitles {
  rename(session: HostSession, title: string): { title: string; eventSeq?: number };
}

interface HostAgentPresets {
  resolve(id?: string): Promise<{ id: string }>;
  mount(agentCtx: unknown, id?: string): Promise<unknown>;
}

interface HostDefaultModel {
  currentSelection(): { provider?: string; model?: string } | undefined;
}

interface HostSessionStore {
  list(): Array<{ id: HostSessionId }>;
  get(id: HostSessionId): unknown;
}

/** Per-agent route. dsh resolves prompt variables such as `{{model}}` from it. */
export interface HostAgentOptions {
  provider?: string;
  model?: string;
}

interface HostAgentRegistry {
  create(options: {
    sessionId: HostSessionId;
    meta?: { cwd?: string; agentPreset?: string };
    agentOptions?: HostAgentOptions;
    setup?: (agentCtx: unknown) => Promise<void> | void;
  }): Promise<{ agent: HostAgent; dispose(): Promise<void> }>;
  resume(options: {
    resumeSessionId: HostSessionId;
    agentOptions?: HostAgentOptions;
    setup?: (agentCtx: unknown) => Promise<void> | void;
  }): Promise<{ agent: HostAgent; dispose(): Promise<void> }>;
  get(id: HostSessionId): HostAgent | undefined;
  list(): HostAgent[];
}

/** The cordis context shape this facade reads, kept structural on purpose. */
export interface HostContextLike {
  get?(name: string): unknown;
  root?: HostContextLike;
  on?(event: string, listener: (...args: unknown[]) => void): () => void;
  /**
   * cordis' dependency gate. Present from cordis 4 onward; used to WAIT for a
   * service that dsh provides asynchronously (see {@link service}).
   *
   * The return type is `unknown` on purpose: cordis hands back a `Fiber` that
   * also implements `PromiseLike`, and this facade only ever ignores it.
   */
  inject?(names: string[], callback: (ctx: unknown) => unknown): unknown;
}

function isFn(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

/**
 * How long the bridge waits for a host service that dsh provides asynchronously.
 * dsh 0.1.5 publishes `sessionPersistence` a few hundred ms after the plugin
 * tree is ready; 15s is far above the observed delay while still bounded.
 */
const SERVICE_WAIT_MS = 15_000;

/**
 * Read a service without waiting. Synchronous on purpose: callers such as
 * {@link hostServicesAvailable} inspect the result inline.
 *
 * @param ctx - the host context the bridge was mounted on.
 * @param name - the service name.
 * @returns the service value, or `undefined` when it is not provided (yet).
 */
function service(ctx: HostContextLike, name: string): unknown {
  const contexts: HostContextLike[] = [ctx];
  try {
    if (ctx.root && ctx.root !== ctx) contexts.push(ctx.root);
  } catch {
  }
  for (const candidate of contexts) {
    try {
      const value = (candidate as unknown as Record<string, unknown>)[name];
      if (value !== undefined) return value;
    } catch {
    }
    if (isFn(candidate.get)) {
      try {
        const value = (candidate.get as (n: string) => unknown)(name);
        if (value !== undefined) return value;
      } catch {
      }
    }
  }
  return undefined;
}

/**
 * Read a service, waiting briefly for dsh to publish it.
 *
 * dsh 0.1.5 provides some services (notably `sessionPersistence`) a few hundred
 * milliseconds AFTER the plugin tree reports ready. The bridge starts its
 * startup catch-up immediately, so a single synchronous read raced the
 * provider and turned a "not yet" into a hard failure. Here the read parks on
 * cordis' own dependency gate (`ctx.inject`) until the service appears.
 *
 * @param ctx - the host context the bridge was mounted on.
 * @param name - the service name.
 * @param waitMs - upper bound in milliseconds; the read is immediate when the
 *   service is already there, and falls back to the plain read otherwise.
 * @returns the service value, or `undefined` when it never appeared in time.
 */
/**
 * Read a service, waiting until dsh publishes it.
 *
 * dsh 0.1.5 provides some services (notably `sessionPersistence`) a few hundred
 * milliseconds AFTER the plugin tree reports ready. The bridge starts its
 * startup catch-up immediately, so a single synchronous read raced the provider
 * and turned a "not yet" into a hard failure — which surfaced as the
 * `dsh session persistence is unavailable` loop every reconnect (5s).
 *
 * Deliberately implemented as a plain poll of `ctx.get(name)`: it must not
 * depend on any cordis-specific helper (an earlier attempt used `ctx.inject`
 * and never actually waited in the live process), and the context handed to the
 * bridge may be a plain structural object rather than a cordis instance.
 *
 * @param ctx - the host context the bridge was mounted on.
 * @param name - the service name.
 * @param waitMs - upper bound in milliseconds. Returns immediately when the
 *   service is already published.
 * @returns the service value, or `undefined` when it never appeared in time.
 */
async function serviceOrWait(ctx: HostContextLike, name: string, waitMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const value = service(ctx, name);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      timer.unref?.();
    });
  }
}

function asRegistry(value: unknown): HostAgentRegistry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<HostAgentRegistry>;
  return isFn(candidate.create) && isFn(candidate.resume) && isFn(candidate.get) &&
    isFn(candidate.list)
    ? (value as HostAgentRegistry)
    : undefined;
}

/**
 * Whether this context can drive sessions in-process.
 * @param ctx - the context the plugin was mounted on, if any.
 */
export function hostServicesAvailable(ctx: HostContextLike | undefined): boolean {
  return ctx !== undefined && asRegistry(service(ctx, 'agents')) !== undefined;
}

/**
 * dsh's own message/identity factories, loaded from the host at runtime.
 *
 * These are deliberately NOT package dependencies. dsh core packages carry
 * module-level identity (the compatibility notes call out the duplicated
 * scheduler Symbol), so installing a second copy alongside the host's would be
 * worse than not having them: the bridge would build messages with a different
 * module instance than the agent validating them. Resolving them from the
 * running host guarantees one copy, and the dynamic import keeps this file
 * loadable where they do not exist at all.
 */
export interface HostFactories {
  createUserMessage(input: {
    content: ReadonlyArray<{ type: 'text'; text: string }>;
    source: { kind: 'user'; client?: string; rpcId?: string };
  }): unknown;
  SessionId(id: string): HostSessionId;
}

let factoriesPromise: Promise<HostFactories> | undefined;

/**
 * Load dsh's factories from the running host.
 *
 * Exported so callers that already hold them — or tests, which run with no
 * host present at all — can supply them instead of reaching for a module that
 * only exists inside dsh.
 */
export async function loadHostFactories(): Promise<HostFactories> {
  factoriesPromise ??= (async () => {
    // Indirect specifiers on purpose: these packages are resolved from the
    // running host, so they must stay a runtime concern. A literal specifier
    // would make the compiler demand a dependency we must not declare.
    const llmSpecifier = '@deepseek-ai/dsh-llm';
    const sessionSpecifier = '@deepseek-ai/dsh-session';
    const load = (specifier: string): Promise<Partial<HostFactories>> =>
      import(specifier) as Promise<Partial<HostFactories>>;
    const [llm, session] = await Promise.all([
      load(llmSpecifier),
      load(sessionSpecifier),
    ]);
    if (!isFn(llm.createUserMessage) || !isFn(session.SessionId)) {
      throw new Error('dsh message factories are missing from the host');
    }
    return {
      createUserMessage: llm.createUserMessage,
      SessionId: session.SessionId,
    } as HostFactories;
  })().catch((error: unknown) => {
    // Do not cache a transient failure as a permanent one.
    factoriesPromise = undefined;
    throw new Error(
      `dsh in-process message factories unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return factoriesPromise;
}

/** Typed, validation-owning facade over the in-process host services. */
export class HostServices {
  private readonly factories: () => Promise<HostFactories>;

  /**
   * @param ctx - the context this plugin is mounted on.
   * @param factories - override for dsh's message/identity factories; defaults
   *   to loading them from the running host.
   */
  constructor(
    private readonly ctx: HostContextLike,
    factories: (() => Promise<HostFactories>) | undefined = undefined,
  ) {
    this.factories = factories ?? loadHostFactories;
  }

  /** The in-process session manager, when the GUI row has mounted it. */
  sessionCore(): SessionCore | undefined {
    const provided = service(this.ctx, 'dshSessionCore');
    if (provided && typeof (provided as SessionCore).listActive === 'function') {
      return provided as SessionCore;
    }
    return getSessionCore();
  }

  private registry(): HostAgentRegistry {
    const registry = asRegistry(service(this.ctx, 'agents'));
    if (!registry) {
      throw new Error(
        'dsh in-process agent registry is unavailable; this adapter only runs ' +
          'as a plugin inside dsh (set DSH_LARK_ADAPTER=sdk to run out of process)',
      );
    }
    return registry;
  }

  /**
   * Resolve the live agent for a persisted session, resuming it when the
   * registry has no live entry yet.
   * @param sessionId - persisted session identity.
   * @returns the live agent, or undefined when the session cannot be loaded.
   */
  async agentFor(
    sessionId: HostSessionId,
    route: HostAgentOptions = {},
  ): Promise<HostAgent | undefined> {
    const registry = this.registry();
    const live = registry.get(sessionId);
    if (live) return live;
    try {
      // A resumed agent needs the route just as much as a created one: prompt
      // assembly reads `{{model}}` from the agent's options, not from the
      // session it was loaded from. Passing it only on create left every
      // existing session — which is every chat already bound to one — failing
      // on its next turn.
      // A resumed agent is composed from scratch too, so it needs the same
      // preset mount as a created one — otherwise resuming a session strips
      // its tools.
      const composition = await this.composition();
      return (await registry.resume({
        resumeSessionId: sessionId,
        agentOptions: this.resolveRoute(route),
        ...(composition === undefined ? {} : { setup: composition.setup }),
      })).agent;
    } catch {
      // A deleted, purged or unreadable session is a caller-visible miss, not
      // a fault: the run-flow falls back to creating a fresh session.
      return undefined;
    }
  }

  /**
   * Merge a caller route with the host default, dropping empty values.
   * @param route - caller-supplied provider/model, either possibly blank.
   */
  private resolveRoute(route: HostAgentOptions): HostAgentOptions {
    // An unset DSH_LARK_MODEL surfaces as an empty string rather than
    // undefined, and an empty model would override the host default with
    // nothing — the exact shape that breaks prompt assembly.
    const nonEmpty = (value: string | undefined): string | undefined =>
      value === undefined || value.trim() === '' ? undefined : value;
    const fallback = this.defaultRoute();
    const provider = nonEmpty(route.provider) ?? nonEmpty(fallback.provider);
    const model = nonEmpty(route.model) ?? nonEmpty(fallback.model);
    return {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    };
  }

  /**
   * Create a fresh session and its live agent.
   *
   * The route must be passed at creation: dsh resolves prompt variables from
   * the agent's own options, so an agent created without one fails prompt
   * assembly with `prompt variable "{{model}}" has no value` before it ever
   * reaches the provider.
   * @param sessionId - identity to mint the session under.
   * @param cwd - validated absolute workspace path, when known.
   * @param route - provider/model for this agent.
   */
  async createAgent(
    sessionId: HostSessionId,
    cwd: string | undefined,
    route: HostAgentOptions = {},
  ): Promise<HostAgent> {
    // Fall back to the host's own default route, which is what dsh's session
    // controller does. The bridge often has no model of its own (an unset
    // DSH_LARK_MODEL leaves it empty), and an agent created with no route at
    // all cannot resolve `{{model}}` during prompt assembly.
    const agentOptions = this.resolveRoute(route);
    const composition = await this.composition();
    const meta = {
      ...(cwd === undefined ? {} : { cwd }),
      ...(composition?.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
    };
    const { agent } = await this.registry().create({
      sessionId,
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
      ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
      ...(composition === undefined ? {} : { setup: composition.setup }),
    });
    return agent;
  }

  /** Every session the registry currently holds live. */
  liveAgents(): HostAgent[] {
    try {
      return this.registry().list();
    } catch {
      return [];
    }
  }

  /**
   * Build one identified user message through the host's own factory.
   * @param text - the user's prompt text, already stripped of bridge preamble.
   */
  async userMessage(text: string, provenance?: { client: string; rpcId: string }): Promise<unknown> {
    const { createUserMessage } = await this.factories();
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user', ...(provenance ?? {}) },
    });
  }

  /**
   * Mint a fresh session identity through the host's own brand function.
   * @param raw - the unbranded identity to adopt.
   */
  async sessionId(raw: string): Promise<HostSessionId> {
    const { SessionId } = await this.factories();
    return SessionId(raw);
  }

  /**
   * Every persisted session's header. Live-only `ctx.sessions.list()` is not
   * enough for the Feishu session list: a session the user switched away from
   * is still selectable, and is not live.
   * @returns the headers, or an empty list when persistence is unavailable.
   */
  async sessionHeaders(): Promise<readonly HostSessionHeader[]> {
    const persistence = await serviceOrWait(this.ctx, 'sessionPersistence', SERVICE_WAIT_MS) as HostSessionPersistence | undefined;
    if (!persistence || !isFn(persistence.list)) return [];
    try {
      return sessionHeaderList(await persistence.list()) as HostSessionHeader[];
    } catch {
      return [];
    }
  }

  /**
   * Read one session's durable log.
   * @param sessionId - the session to read.
   * @param fromSeq - first event seq to include.
   */
  async readSessionLog(sessionId: HostSessionId, fromSeq = 0): Promise<HostSessionLog> {
    const persistence = await serviceOrWait(this.ctx, 'sessionPersistence', SERVICE_WAIT_MS) as HostSessionPersistence | undefined;
    if (!persistence) {
      throw new Error('dsh session persistence is unavailable');
    }
    if (isFn(persistence.readFrom)) return persistence.readFrom(sessionId, fromSeq);
    if (!isFn(persistence.open)) throw new Error('dsh session persistence is unavailable');
    const handle = await persistence.open(sessionId, 'read');
    try {
      return await handle.read(fromSeq);
    } finally {
      await handle.close();
    }
  }

  /**
   * The session's projected title, when the query engine has one.
   * @param sessionId - the session to look up.
   */
  async sessionTitle(sessionId: HostSessionId): Promise<string | undefined> {
    const query = await serviceOrWait(this.ctx, 'sessionQuery', SERVICE_WAIT_MS) as HostSessionQuery | undefined;
    if (!query || !isFn(query.readTitleSnapshot)) return undefined;
    try {
      const snapshot = await query.readTitleSnapshot(sessionId);
      const title = snapshot?.title?.trim();
      return title === undefined || title === '' ? undefined : title;
    } catch {
      return undefined;
    }
  }

  /**
   * Set a session's user-chosen name through dsh's title service.
   *
   * Resuming the agent first is not incidental: `rename` writes into the live
   * session, so the session has to be loaded for the title event to land in
   * its log. That is also how dsh's own `session/rename` endpoint does it.
   *
   * @param sessionId - the session to name.
   * @param title - the proposed name; the service normalises and may trim it.
   * @param route - provider/model for the resume, as elsewhere.
   * @returns the name the service actually accepted.
   */
  async renameSession(
    sessionId: HostSessionId,
    title: string,
    route: HostAgentOptions = {},
  ): Promise<string> {
    const controller = service(this.ctx, 'sessionController') as {
      rename?: (request: { sessionId: HostSessionId; title: string }) => Promise<{ title?: string }>;
    } | undefined;
    if (controller && isFn(controller.rename)) {
      const result = await controller.rename({ sessionId, title });
      return typeof result?.title === 'string' && result.title.trim() !== ''
        ? result.title.trim()
        : title;
    }
    const titles = await serviceOrWait(this.ctx, 'sessionTitle', SERVICE_WAIT_MS) as HostSessionTitles | undefined;
    if (!titles || !isFn(titles.rename)) {
      throw new Error('this dsh deployment mounts no session-title service');
    }
    const agent = await this.agentFor(sessionId, route);
    if (!agent) throw new Error(`session ${String(sessionId)} could not be resumed`);
    const accepted = titles.rename(agent.session, title);
    return typeof accepted?.title === 'string' && accepted.title.trim() !== ''
      ? accepted.title.trim()
      : title;
  }

  /**
   * Build the agent-composition callback dsh runs while an agent is still
   * unpublished.
   *
   * This is where an agent gets its tools. dsh's own session controller mounts
   * an agent preset here; skipping it produced agents that could only send
   * messages — `write`, `read`, `glob` and `pwsh` all came back as
   * "unknown tool", which reads like a broken session rather than a missing
   * setup callback.
   *
   * @returns the preset id and its mount callback, or undefined when this host
   *   registers no preset service (then dsh's own default composition applies).
   */
  private async composition(): Promise<{
    agentPreset?: string;
    setup: (agentCtx: unknown) => Promise<void>;
  } | undefined> {
    const presets = service(this.ctx, 'agentPresets') as HostAgentPresets | undefined;
    if (!presets || !isFn(presets.resolve) || !isFn(presets.mount)) return undefined;
    try {
      const resolved = await presets.resolve();
      return {
        agentPreset: resolved.id,
        setup: async (agentCtx: unknown) => {
          await presets.mount(agentCtx, resolved.id);
        },
      };
    } catch {
      // A preset that cannot be resolved must not block the session: dsh
      // falls back to its own composition when no setup is supplied.
      return undefined;
    }
  }

  /**
   * dsh's configured default provider/model.
   * @returns the selection, or empty when the host exposes none.
   */
  defaultRoute(): HostAgentOptions {
    // Synchronous on purpose: dsh publishes `agentDefaultModel` with the tree,
    // unlike `sessionPersistence`, so this needs no wait.
    const service_ = service(this.ctx, 'agentDefaultModel') as HostDefaultModel | undefined;
    if (!service_ || !isFn(service_.currentSelection)) return {};
    try {
      const selection = service_.currentSelection();
      return {
        ...(selection?.provider === undefined ? {} : { provider: selection.provider }),
        ...(selection?.model === undefined ? {} : { model: selection.model }),
      };
    } catch {
      return {};
    }
  }

  /** Session ids the host currently holds live (used for the running flag). */
  liveSessionIds(): Set<HostSessionId> {
    const store = service(this.ctx, 'sessions') as HostSessionStore | undefined;
    if (!store || !isFn(store.list)) return new Set();
    try {
      return new Set(store.list().map((session) => session.id));
    } catch {
      return new Set();
    }
  }

  /**
   * Subscribe to the host-wide session event feed.
   * @param onEvent - receives every event with the session that produced it.
   * @returns the unsubscribe function, or undefined when the context has no event bus.
   */
  onSessionEvent(
    onEvent: (sessionId: HostSessionId, event: HostSessionEvent) => void,
  ): (() => void) | undefined {
    if (!isFn(this.ctx.on)) return undefined;
    return (this.ctx.on as (
      event: string,
      listener: (session: unknown, event: unknown) => void,
    ) => () => void)('session/event', (session, event) => {
      const id = (session as HostSession | undefined)?.id;
      if (typeof id !== 'string') return;
      const frame = event as HostSessionEvent | undefined;
      if (!frame || typeof frame.type !== 'string' || typeof frame.seq !== 'number') return;
      onEvent(id, frame);
    });
  }
}
