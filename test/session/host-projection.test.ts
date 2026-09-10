import { describe, expect, it, vi } from 'vitest';
import { HostSessionProjectionSource } from '../../src/session/host-projection.js';
import type { HostServices } from '../../src/adapters/dsh/host-services.js';
import type { SessionEventFrame } from '../../src/session/projection-protocol.js';

interface FakeServicesOptions {
  headers?: Array<Record<string, unknown>>;
  live?: string[];
  titles?: Record<string, string>;
  log?: { meta?: unknown; events?: Array<Record<string, unknown>> };
  resumable?: string[];
}

function fakeServices(options: FakeServicesOptions = {}): {
  services: HostServices;
  followups: unknown[];
  listeners: Array<(sessionId: string, event: unknown) => void>;
  unsubscribed: number;
} {
  const followups: unknown[] = [];
  const listeners: Array<(sessionId: string, event: unknown) => void> = [];
  const state = { unsubscribed: 0 };
  const services = {
    sessionHeaders: async () => options.headers ?? [],
    liveSessionIds: () => new Set(options.live ?? []),
    sessionTitle: async (id: string) => options.titles?.[id],
    readSessionLog: async () => options.log ?? { events: [] },
    userMessage: async (text: string) => ({ role: 'user', text }),
    sessionId: async (raw: string) => raw,
    agentFor: async (id: string) =>
      (options.resumable ?? []).includes(id)
        ? { id, followup: (m: unknown) => followups.push(m) }
        : undefined,
    createAgent: async (id: string) => ({ id }),
    onSessionEvent: (listener: (sessionId: string, event: unknown) => void) => {
      listeners.push(listener);
      return () => {
        state.unsubscribed += 1;
      };
    },
  } as unknown as HostServices;
  return {
    services,
    followups,
    listeners,
    get unsubscribed() {
      return state.unsubscribed;
    },
  } as ReturnType<typeof fakeServices>;
}

const endpoints = { baseUrl: 'http://127.0.0.1:3080' };

function stubFetch(handler: (url: string) => { status?: number; body: unknown }): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const { status = 200, body } = handler(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }));
}

describe('HostSessionProjectionSource', () => {
  it('lists sessions newest first, marking live and trashed ones', async () => {
    stubFetch((url) => url.includes('/trash/list')
      ? { body: { items: [{ sessionId: 's-old' }] } }
      : { body: { items: [
          { sessionId: 's-old', workspacePath: '/repo', title: 'older work', createdAt: 100 },
          { sessionId: 's-new', workspacePath: '/repo', title: 'newer work', createdAt: 300 },
        ] } });
    const { services } = fakeServices({ live: ['s-new'] });

    const list = await new HostSessionProjectionSource(services, endpoints).listSessions();

    expect(list.map((s) => s.sessionId)).toEqual(['s-new', 's-old']);
    expect(list[0]).toMatchObject({ running: true, title: 'newer work', cwd: '/repo' });
    expect(list[0]?.trashed).toBeUndefined();
    // A session in the recycle bin stays listed, but flagged, so /use can
    // refuse it and /purge can still target it.
    expect(list[1]).toMatchObject({ running: false, trashed: true });
  });

  it('carries the workspace path, without which no session is selectable', async () => {
    // The chooser matches a session to the chat by exact cwd, so a summary
    // with no cwd silently drops out of /use, /delete and /purge.
    stubFetch((url) => url.includes('/trash/list')
      ? { body: { items: [] } }
      : { body: { items: [
          { sessionId: 's1', workspacePath: '/repo', title: 'named in the Web UI', createdAt: 5 },
        ] } });
    const { services } = fakeServices();

    const [summary] = await new HostSessionProjectionSource(services, endpoints).listSessions();

    // The same name the Web UI shows, so both surfaces agree.
    expect(summary).toMatchObject({ cwd: '/repo', title: 'named in the Web UI', blank: false });
  });

  it('keeps listing sessions when the recycle bin cannot be read', async () => {
    // An unreadable bin must not blank the session list: losing the trashed
    // marker is recoverable, losing the whole list is not.
    stubFetch((url) => {
      if (url.includes('/trash/list')) throw new Error('trash index locked');
      return { body: { items: [{ sessionId: 's1', workspacePath: '/repo', title: 't', createdAt: 1 }] } };
    });
    const { services } = fakeServices();

    const list = await new HostSessionProjectionSource(services, endpoints).listSessions();

    expect(list).toHaveLength(1);
    expect(list[0]?.trashed).toBeUndefined();
  });

  it('drops subagent sessions, which the listing route cannot mark', async () => {
    // The route carries titles and workspace paths but no delegation metadata,
    // so a subagent session used to be listed and to mint an alias nobody can
    // use (`0910-3`, `0910-4`). The persisted header is the only signal, and
    // each of its three markers is enough on its own.
    stubFetch((url) => url.includes('/trash/list')
      ? { body: { items: [] } }
      : { body: { items: [
          { sessionId: 's-parent', workspacePath: '/repo', title: 'parent work', createdAt: 300 },
          { sessionId: 's-origin', workspacePath: '/repo', title: 'child by origin', createdAt: 200 },
          { sessionId: 's-parent-link', workspacePath: '/repo', title: 'child by link', createdAt: 100 },
          { sessionId: 's-depth', workspacePath: '/repo', title: 'child by depth', createdAt: 50 },
        ] } });
    const { services } = fakeServices({
      headers: [
        { id: 's-parent', delegationDepth: 0 },
        { id: 's-origin', origin: 'subagent', delegationDepth: 1, parentSession: 's-parent' },
        { id: 's-parent-link', parentSession: 's-parent' },
        { id: 's-depth', delegationDepth: 1 },
      ],
    });

    const list = await new HostSessionProjectionSource(services, endpoints).listSessions();

    expect(list.map((session) => session.sessionId)).toEqual(['s-parent']);
  });

  it('keeps every session when the delegation headers are unavailable', async () => {
    // An unreadable header list is reported as empty, which filters nothing:
    // losing the delegation signal costs one stray entry, dropping the whole
    // list over it would cost the session commands.
    stubFetch((url) => url.includes('/trash/list')
      ? { body: { items: [] } }
      : { body: { items: [
          { sessionId: 's1', workspacePath: '/repo', title: 'top level', createdAt: 2 },
          { sessionId: 's2', workspacePath: '/repo', title: 'child', createdAt: 1 },
        ] } });
    const { services } = fakeServices();

    const list = await new HostSessionProjectionSource(services, endpoints).listSessions();

    expect(list.map((session) => session.sessionId)).toEqual(['s1', 's2']);
  });

  it('pages history from the durable log', async () => {
    stubFetch(() => ({ body: { items: [] } }));
    const { services } = fakeServices({
      log: {
        events: [
          { type: 'user/message', seq: 1, time: 1, data: {} },
          { type: 'assistant/message', seq: 2, time: 2, data: {} },
          { type: 'user/message', seq: 3, time: 3, data: {} },
        ],
      },
    });
    const source = new HostSessionProjectionSource(services, endpoints);

    const tail = await source.history('s1', { maxMessages: 2 });
    expect(tail.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(tail.hasMore).toBe(true);

    const before = await source.history('s1', { beforeSeq: 2 });
    expect(before.events.map((e) => e.seq)).toEqual([1]);
    expect(before.hasMore).toBe(false);
  });

  it('prompts through the resumed agent, and refuses a session it cannot resume', async () => {
    stubFetch(() => ({ body: { items: [] } }));
    const fake = fakeServices({ resumable: ['s-live'] });
    const source = new HostSessionProjectionSource(fake.services, endpoints);

    const { rpcId } = await source.prompt('s-live', 'do the thing', 'rpc-7');
    expect(rpcId).toBe('rpc-7');
    expect(fake.followups).toEqual([{ role: 'user', text: 'do the thing' }]);

    await expect(source.prompt('s-gone', 'hi')).rejects.toThrow(/could not be resumed/);
  });

  it('delivers live events and stops on close, without ever asking for a reconnect', async () => {
    stubFetch(() => ({ body: { items: [] } }));
    const fake = fakeServices();
    const source = new HostSessionProjectionSource(fake.services, endpoints);
    const frames: SessionEventFrame[] = [];
    const onClose = vi.fn();

    const stream = await source.openEvents((frame) => frames.push(frame));
    stream.onClose(onClose);
    fake.listeners[0]?.('s1', { type: 'user/message', seq: 4, time: 9, data: { a: 1 } });
    fake.listeners[0]?.('s1', { type: 'not-an-event' });

    expect(frames).toEqual([
      { sessionId: 's1', event: { type: 'user/message', seq: 4, time: 9, data: { a: 1 } } },
    ]);

    stream.close();
    expect(fake.unsubscribed).toBe(1);
    // An in-process bus has no carrier that can drop, so the bridge must never
    // be told to reconnect to it.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('routes recycle-bin and permanent deletion at the unfenced endpoints', async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return { body: { ok: true, trashed: true, purged: true } };
    });
    const { services } = fakeServices();
    const source = new HostSessionProjectionSource(services, endpoints);

    await source.deleteSession('s1');
    await source.purgeSession('s1');

    expect(calls).toEqual([
      'http://127.0.0.1:3080/__chameleon/session/delete',
      'http://127.0.0.1:3080/__chameleon/session/purge',
    ]);
  });

  it('surfaces a refused deletion instead of reporting success', async () => {
    stubFetch(() => ({ body: { ok: false, error: 'session is running' } }));
    const { services } = fakeServices();
    const source = new HostSessionProjectionSource(services, endpoints);

    await expect(source.deleteSession('s1')).rejects.toThrow('session is running');
  });
});
