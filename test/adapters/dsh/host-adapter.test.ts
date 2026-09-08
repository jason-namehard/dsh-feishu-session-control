import { describe, expect, it } from 'vitest';
import { HostDshAdapter } from '../../../src/adapters/dsh/host-adapter.js';
import { hostServicesAvailable } from '../../../src/adapters/dsh/host-services.js';
import type { AgentEvent } from '../../../src/adapters/types.js';

interface FakeEvent {
  type: string;
  seq: number;
  data?: unknown;
}

/**
 * Minimal stand-in for dsh's in-process host: an agent registry plus the
 * `session/event` bus, shaped exactly as a live 0.1.2-rc.1 host exposes them.
 */
class FakeHost {
  created: string[] = [];
  createdOptions: Array<Record<string, unknown> | undefined> = [];
  resumed: string[] = [];
  resumedOptions: Array<Record<string, unknown> | undefined> = [];
  followups: unknown[] = [];
  cancels: unknown[] = [];
  listeners: Array<(session: unknown, event: unknown) => void> = [];
  unsubscribed = 0;
  /** Session ids the registry already holds live. */
  live = new Set<string>();
  /** Session ids that exist on disk and may be resumed. */
  resumable = new Set<string>();
  /** What the host reports as its configured default route. */
  defaultRoute: { provider?: string; model?: string } = {};

  private agent(id: string): Record<string, unknown> {
    return {
      id,
      session: { id },
      status: 'idle',
      followup: (message: unknown) => this.followups.push(message),
      cancel: (cause: unknown) => this.cancels.push(cause),
      whenIdle: async () => undefined,
    };
  }

  get ctx(): {
    get(name: string): unknown;
    on(event: string, listener: (...args: unknown[]) => void): () => void;
  } {
    return {
      get: (name: string) => {
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => this.defaultRoute };
        }
        if (name !== 'agents') return undefined;
        return {
          create: async ({ sessionId, agentOptions }: {
            sessionId: string;
            agentOptions?: Record<string, unknown>;
          }) => {
            this.created.push(sessionId);
            this.createdOptions.push(agentOptions);
            this.live.add(sessionId);
            return { agent: this.agent(sessionId), dispose: async () => undefined };
          },
          resume: async ({ resumeSessionId, agentOptions }: {
            resumeSessionId: string;
            agentOptions?: Record<string, unknown>;
          }) => {
            if (!this.resumable.has(resumeSessionId)) throw new Error('no such session');
            this.resumed.push(resumeSessionId);
            this.resumedOptions.push(agentOptions);
            this.live.add(resumeSessionId);
            return { agent: this.agent(resumeSessionId), dispose: async () => undefined };
          },
          get: (id: string) => (this.live.has(id) ? this.agent(id) : undefined),
          list: () => [...this.live].map((id) => this.agent(id)),
        };
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event !== 'session/event') return () => undefined;
        const bound = listener as (session: unknown, event: unknown) => void;
        this.listeners.push(bound);
        return () => {
          this.unsubscribed += 1;
          this.listeners = this.listeners.filter((entry) => entry !== bound);
        };
      },
    };
  }

  emit(sessionId: string, event: FakeEvent): void {
    for (const listener of [...this.listeners]) listener({ id: sessionId }, event);
  }
}

/**
 * Stand in for dsh's message/identity factories. The real ones live in the
 * host's own module graph, so tests supply them through the adapter seam
 * rather than resolving packages that only exist inside dsh.
 */
const fakeFactories = async (): Promise<{
  createUserMessage(input: {
    content: ReadonlyArray<{ type: 'text'; text: string }>;
    source: { kind: 'user' };
  }): unknown;
  SessionId(id: string): string;
}> => ({
  createUserMessage: (input) => ({ id: 'msg-1', role: 'user', ...input }),
  SessionId: (id) => id,
});

function adapterFor(host: FakeHost, provider?: string): HostDshAdapter {
  return new HostDshAdapter({
    ctx: host.ctx,
    provider,
    model: 'test-model',
    factories: fakeFactories,
  });
}

/** Drain the run's events, driving the host once the turn has been prompted. */
async function collect(
  host: FakeHost,
  run: { events: AsyncIterable<AgentEvent> },
  drive: (sessionId: string) => void,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of run.events) {
    seen.push(event);
    if (event.type === 'system' && event.sessionId) {
      // The prompt is delivered asynchronously; wait for it before emitting so
      // the subscription is guaranteed to be in place.
      const sessionId = event.sessionId;
      void (async () => {
        while (host.followups.length === 0) await new Promise((r) => setTimeout(r, 1));
        drive(sessionId);
      })();
    }
  }
  return seen;
}

describe('hostServicesAvailable', () => {
  it('detects a host that exposes the agent registry', () => {
    expect(hostServicesAvailable(new FakeHost().ctx)).toBe(true);
  });

  it('rejects a context without the registry, and no context at all', () => {
    expect(hostServicesAvailable({ get: () => undefined })).toBe(false);
    expect(hostServicesAvailable(undefined)).toBe(false);
  });
});

describe('HostDshAdapter', () => {
  it('creates a session when the chat has none, and reports it before events', async () => {
    const host = new FakeHost();
    const run = adapterFor(host).run({
      runId: 'r1',
      prompt: 'hello',
      cwd: '/repo',
      sessionId: undefined,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const events = await collect(host, run, (sessionId) => {
      // The host streams assistant text as text-delta chunks and reports token
      // accounting separately on assistant/message.
      host.emit(sessionId, {
        type: 'assistant/chunk',
        seq: 1,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hi there' } },
      });
      host.emit(sessionId, {
        type: 'assistant/message',
        seq: 2,
        data: { id: 'a1', usage: { inputTokens: 11, outputTokens: 4 } },
      });
      host.emit(sessionId, { type: 'turn/end', seq: 3 });
    });

    expect(host.created).toHaveLength(1);
    expect(host.resumed).toEqual([]);
    expect(events[0]).toMatchObject({ type: 'system', cwd: '/repo', model: 'test-model' });
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(events.some((e) => e.type === 'text' && e.delta === 'hi there')).toBe(true);
    expect(events.some((e) => e.type === 'usage' && e.inputTokens === 11)).toBe(true);
    // The listener must be released once the turn settles.
    expect(host.unsubscribed).toBe(1);
    expect(host.listeners).toEqual([]);
  });

  it('creates the agent with a provider/model route', async () => {
    // dsh resolves prompt variables from the agent's own options. Creating one
    // without a route fails prompt assembly with
    // `prompt variable "{{model}}" has no value` before the provider is ever
    // reached — a failure that looks like a model problem, not a missing field.
    const host = new FakeHost();
    const run = adapterFor(host, 'deepseek').run({
      runId: 'r-route',
      prompt: 'hello',
      cwd: '/repo',
      sessionId: undefined,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    await collect(host, run, (sessionId) => {
      host.emit(sessionId, { type: 'turn/end', seq: 1 });
    });

    expect(host.createdOptions).toEqual([{ provider: 'deepseek', model: 'test-model' }]);
  });

  it('falls back to the host default route when the bridge has no model', async () => {
    // An unset DSH_LARK_MODEL arrives as an empty string, which must not
    // override the host default with nothing.
    const host = new FakeHost();
    host.defaultRoute = { provider: 'deepseek', model: 'deepseek-v4-flash' };
    const adapter = new HostDshAdapter({
      ctx: host.ctx,
      provider: undefined,
      model: '',
      factories: fakeFactories,
    });
    const run = adapter.run({
      runId: 'r-default',
      prompt: 'hello',
      cwd: '/repo',
      sessionId: undefined,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    await collect(host, run, (sessionId) => {
      host.emit(sessionId, { type: 'turn/end', seq: 1 });
    });

    expect(host.createdOptions).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
    ]);
  });

  it('lets the run override the adapter default route', async () => {
    const host = new FakeHost();
    const run = adapterFor(host, 'deepseek').run({
      runId: 'r-override',
      prompt: 'hello',
      cwd: '/repo',
      sessionId: undefined,
      provider: 'other',
      model: 'other-model',
      images: undefined,
      stopGraceMs: undefined,
    });
    await collect(host, run, (sessionId) => {
      host.emit(sessionId, { type: 'turn/end', seq: 1 });
    });

    expect(host.createdOptions).toEqual([{ provider: 'other', model: 'other-model' }]);
  });

  it('resumes a persisted session instead of creating a new one', async () => {
    const host = new FakeHost();
    host.resumable.add('session-old');
    const run = adapterFor(host).run({
      runId: 'r2',
      prompt: 'Current user message:\nsecond turn',
      cwd: '/repo',
      sessionId: 'session-old',
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const events = await collect(host, run, (sessionId) => {
      host.emit(sessionId, { type: 'turn/end', seq: 9 });
    });

    expect(host.resumed).toEqual(['session-old']);
    expect(host.created).toEqual([]);
    expect(events[0]).toMatchObject({ type: 'system', sessionId: 'session-old' });
    // Only the user's own text is sent; the replayed transcript preamble is not.
    expect(JSON.stringify(host.followups[0])).toContain('second turn');
    expect(JSON.stringify(host.followups[0])).not.toContain('Current user message');
  });

  it('gives a resumed session the route as well, not just a created one', async () => {
    // Prompt assembly reads the route off the agent, not off the session it was
    // loaded from. Passing it only on create left every chat already bound to a
    // session failing on its next turn.
    const host = new FakeHost();
    host.resumable.add('session-old');
    host.defaultRoute = { provider: 'deepseek', model: 'deepseek-v4-flash' };
    const adapter = new HostDshAdapter({
      ctx: host.ctx,
      provider: undefined,
      model: '',
      factories: fakeFactories,
    });
    const run = adapter.run({
      runId: 'r-resume-route',
      prompt: 'hello',
      cwd: '/repo',
      sessionId: 'session-old',
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    await collect(host, run, (sessionId) => {
      host.emit(sessionId, { type: 'turn/end', seq: 1 });
    });

    expect(host.resumed).toEqual(['session-old']);
    expect(host.resumedOptions).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
    ]);
  });

  it('falls back to a fresh session when the named one cannot be resumed', async () => {
    const host = new FakeHost();
    const run = adapterFor(host).run({
      runId: 'r3',
      prompt: 'hello',
      cwd: '/repo',
      sessionId: 'session-gone',
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const events = await collect(host, run, (sessionId) => {
      host.emit(sessionId, { type: 'turn/end', seq: 1 });
    });

    expect(host.created).toHaveLength(1);
    expect(host.created[0]).not.toBe('session-gone');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('ignores events belonging to other sessions', async () => {
    const host = new FakeHost();
    const run = adapterFor(host).run({
      runId: 'r4',
      prompt: 'hello',
      cwd: '/repo',
      sessionId: undefined,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const events = await collect(host, run, (sessionId) => {
      host.emit('someone-elses-session', {
        type: 'assistant/message',
        seq: 1,
        data: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 'not mine' }] },
      });
      host.emit(sessionId, { type: 'turn/end', seq: 2 });
    });

    expect(events.some((e) => e.type === 'final_text')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('cancels the agent on stop and reports the run as interrupted', async () => {
    const host = new FakeHost();
    const adapter = adapterFor(host);
    const run = adapter.run({
      runId: 'r5',
      prompt: 'long task',
      cwd: '/repo',
      sessionId: undefined,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const seen: AgentEvent[] = [];
    // stop() resolves only once the run settles, and settling needs this loop
    // to keep draining, so the two must not be serialised.
    const draining = (async () => {
      for await (const event of run.events) seen.push(event);
    })();
    while (host.followups.length === 0) await new Promise((r) => setTimeout(r, 1));
    await run.stop();
    await draining;

    expect(host.cancels).toEqual([{ kind: 'user' }]);
    expect(seen.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    expect(host.listeners).toEqual([]);
  });

  it('surfaces a host without an agent registry as a run error', async () => {
    const adapter = new HostDshAdapter({
      ctx: { get: () => undefined },
      provider: undefined,
      model: 'test-model',
      factories: fakeFactories,
    });
    const run = adapter.run({
      runId: 'r6',
      prompt: 'hello',
      cwd: '/repo',
      sessionId: undefined,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const seen: AgentEvent[] = [];
    for await (const event of run.events) seen.push(event);

    const failure = seen.find((event) => event.type === 'error');
    expect(failure).toBeDefined();
    expect(failure && 'message' in failure ? failure.message : '').toContain(
      'agent registry is unavailable',
    );
    // A failed run must not also claim success.
    expect(seen.some((event) => event.type === 'done')).toBe(false);
  });

  it('stops reporting availability once disposed', async () => {
    const adapter = adapterFor(new FakeHost());
    expect(await adapter.isAvailable()).toBe(true);
    expect(adapter.canResume({ cwd: '/repo', sessionId: 's1', model: undefined })).toBe(true);
    await adapter.dispose();
    expect(await adapter.isAvailable()).toBe(false);
    expect(adapter.canResume({ cwd: '/repo', sessionId: 's1', model: undefined })).toBe(false);
  });
});
