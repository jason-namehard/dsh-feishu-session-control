import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types.js';
import { EventChannel } from './event-channel.js';
import { translateSessionEvent } from './sdk-translate.js';
import {
  HostServices,
  hostServicesAvailable,
  type HostAgent,
  type HostContextLike,
  type HostFactories,
} from './host-services.js';

export interface HostAdapterOptions {
  /** The cordis context this plugin is mounted on. */
  ctx: HostContextLike;
  provider: string | undefined;
  model: string;
  /** Override dsh's message/identity factories (tests); otherwise loaded from the host. */
  factories?: () => Promise<HostFactories>;
}

/**
 * Strip the history preamble the bridge run-flow prepends and send only the
 * user's message: the host already holds the whole session, so re-sending the
 * transcript would duplicate it.
 */
function extractUserText(prompt: string): string {
  const marker = 'Current user message:\n';
  const index = prompt.lastIndexOf(marker);
  return index === -1 ? prompt : prompt.slice(index + marker.length);
}

function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs > 0 ? timeoutMs : 5_000);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface HostRunHandle {
  events: AsyncIterable<AgentEvent>;
  settled: Promise<void>;
  stop: () => void;
}

/**
 * Drive one turn on an in-process agent.
 *
 * The lifecycle mirrors the web adapter's so the run-flow above observes
 * identical ordering: one `system` frame carrying the resolved session, the
 * translated session events, then exactly one `done` or `error`.
 */
function createHostRun(
  services: HostServices,
  options: {
    sessionId: string | undefined;
    prompt: string;
    cwd: string | undefined;
    model: string | undefined;
  },
): HostRunHandle {
  const channel = new EventChannel<AgentEvent>();
  const tracker: { emitted: Set<string> } = { emitted: new Set() };
  const stopRequested = { value: false };
  const turnEnded = deferred<void>();
  const sessionReady = deferred<{
    sessionId: string | undefined;
    cwd: string | undefined;
    model: string | undefined;
  }>();
  let hadError = false;
  let unsubscribe: (() => void) | undefined;
  let agent: HostAgent | undefined;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    turnEnded.resolve();
  };

  const task = (async () => {
    try {
      // Resolve the target agent: reuse or resume the named session, and only
      // mint a new one when the chat has no usable session yet.
      if (options.sessionId) agent = await services.agentFor(options.sessionId);
      if (!agent) {
        agent = await services.createAgent(
          await services.sessionId(`session-${randomUUID()}`),
          options.cwd,
        );
      }
      const sessionId = agent.id;
      sessionReady.resolve({ sessionId, cwd: options.cwd, model: options.model });

      // Subscribe BEFORE prompting so no event of this turn can be missed.
      unsubscribe = services.onSessionEvent((eventSessionId, event) => {
        if (eventSessionId !== sessionId) return;
        for (const translated of translateSessionEvent(event, tracker)) {
          if (translated.type === 'error') hadError = true;
          channel.push(translated);
        }
        if (event.type === 'turn/end') finish();
      });
      if (!unsubscribe) {
        throw new Error('dsh host context exposes no session event bus');
      }

      agent.followup(await services.userMessage(extractUserText(options.prompt)));

      await new Promise<void>((resolve) => {
        void turnEnded.promise.then(() => resolve());
        const timer = setInterval(() => {
          if (stopRequested.value) {
            clearInterval(timer);
            resolve();
          }
        }, 250);
        void turnEnded.promise.finally(() => clearInterval(timer));
      });
    } catch (error) {
      sessionReady.resolve({
        sessionId: options.sessionId,
        cwd: options.cwd,
        model: options.model,
      });
      if (!stopRequested.value) {
        hadError = true;
        channel.push({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          terminationReason: 'failed',
        });
      }
    } finally {
      finish();
      unsubscribe?.();
      unsubscribe = undefined;
      channel.close();
    }
  })();

  async function* events(): AsyncGenerator<AgentEvent> {
    const info = await sessionReady.promise;
    yield { type: 'system', sessionId: info.sessionId, cwd: info.cwd, model: info.model };
    for await (const event of channel) yield event;
    await task;
    if (!hadError) {
      yield {
        type: 'done',
        sessionId: info.sessionId,
        terminationReason: stopRequested.value ? 'interrupted' : 'normal',
      };
    }
  }

  return {
    events: events(),
    settled: task.then(() => undefined),
    stop: (): void => {
      stopRequested.value = true;
      try {
        // A user stop clears queued work as well as the active turn, which is
        // what the Feishu stop button means.
        agent?.cancel({ kind: 'user' });
      } catch {
        // The agent may already have retired; finishing below is enough.
      }
      finish();
    },
  };
}

/**
 * `host` adapter: drive dsh's agents through the in-process registry.
 *
 * This is the same agent registry the browser UI drives, so a Feishu chat and
 * a browser tab bound to one session see one conversation with a single
 * writer. Unlike the `web` adapter it reaches the host directly instead of
 * over loopback HTTP, which removes browser authentication, RPC naming and the
 * event-mux endpoint from the compatibility surface entirely — all three of
 * which broke in dsh 0.1.2-rc.1.
 */
export class HostDshAdapter implements AgentAdapter {
  readonly id = 'dsh-host';
  readonly displayName = 'DeepSeek Harness (in-process)';
  /** The host owns each session across turns, so runs resume natively. */
  readonly resumeCapable = true;

  private readonly services: HostServices;
  private readonly model: string;
  private disposed = false;

  constructor(options: HostAdapterOptions) {
    this.services = new HostServices(options.ctx, options.factories);
    this.model = options.model;
  }

  /**
   * Whether this live instance can still resume the named session. The host is
   * the single writer and holds sessions across connections, so the only
   * blocker is bridge shutdown; an unknown or purged session id is handled by
   * the run-flow fallback instead.
   */
  canResume(_options: {
    runtimeKey?: string;
    cwd: string | undefined;
    sessionId: string;
    provider?: string;
    model: string | undefined;
  }): boolean {
    return !this.disposed;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    if (this.disposed) {
      return { ok: false, error: 'adapter disposed', version: undefined };
    }
    return { ok: true, error: undefined, version: 'dsh-host (in-process)' };
  }

  run(options: AgentRunOptions): AgentRun {
    const handle = createHostRun(this.services, {
      sessionId: options.sessionId,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model: options.model ?? this.model,
    });
    return {
      runId: options.runId,
      events: handle.events,
      stop: async (): Promise<void> => {
        handle.stop();
        await handle.settled;
      },
      waitForExit: (timeoutMs: number) => waitWithTimeout(handle.settled, timeoutMs),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export { hostServicesAvailable };
