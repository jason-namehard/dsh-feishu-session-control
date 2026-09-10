import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/notify/approval-answerer.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

type Listener = (request: unknown, next: () => Promise<string>) => Promise<string>;

/** Capture the one listener the module installs, and nothing else. */
function install(config: { endpoint?: string; token?: string } = {
  endpoint: 'http://127.0.0.1:1234/approval',
  token: 'secret',
}): { listener: Listener; events: string[] } {
  let listener: Listener | undefined;
  const events: string[] = [];
  apply({
    on: vi.fn((event: string, value: Listener) => {
      events.push(event);
      if (event === 'approval/request') listener = value;
    }),
    tools: { get: vi.fn() },
  } as never, config);
  if (listener === undefined) throw new Error('approval/request listener was not installed');
  return { listener, events };
}

function respond(body: unknown, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok, json: async () => body }) as never;
}

const request = (extra: Record<string, unknown> = {}): unknown => ({
  agent: { session: { id: 'session-1' } },
  toolName: 'pwsh',
  ...extra,
});

describe('lark approval answerer', () => {
  it('returns a Feishu decision without ever asking the desktop', async () => {
    respond({ ok: true, owned: true, outcome: 'allowed-once' });
    const { listener } = install();
    const next = vi.fn(async () => 'unavailable');

    await expect(listener(request(), next)).resolves.toBe('allowed-once');

    // The whole point of the rewrite: a card that Feishu answered must not have
    // produced a second prompt the desktop can never close.
    expect(next).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('forwards the request fields the card renderer needs', async () => {
    respond({ ok: true, owned: true, outcome: 'allowed-once' });
    const { listener } = install();

    await listener(request({ callId: 'call-1', reason: 'Run the requested test suite' }), async () => 'unavailable');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/approval',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: 'secret',
          sessionId: 'session-1',
          toolName: 'pwsh',
          callId: 'call-1',
          reason: 'Run the requested test suite',
        }),
      }),
    );
  });

  it('treats a Feishu rejection as final', async () => {
    respond({
      ok: true,
      owned: true,
      outcome: 'rejected',
      denial: {
        layer: 'dsh-native-approval',
        reason: 'DSH rejected this tool request',
        toChange: 'approve it in DSH Web or Feishu',
      },
    });
    const { listener } = install();
    const next = vi.fn(async () => 'allowed-once');

    await expect(listener(request(), next)).resolves.toBe('rejected');

    // A rejected card used to fall through to the desktop and ask again.
    expect(next).not.toHaveBeenCalled();
  });

  it('reports a Feishu-owned cancellation as cancelled', async () => {
    respond({ ok: true, owned: true, outcome: 'cancelled' });
    const { listener } = install();
    const next = vi.fn(async () => 'allowed-once');

    await expect(listener(request(), next)).resolves.toBe('cancelled');
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps an owned request with Feishu even when the response carries no usable outcome', async () => {
    respond({ ok: false, owned: true, error: 'approval cancelled' }, false);
    const { listener } = install();
    const next = vi.fn(async () => 'allowed-once');

    await expect(listener(request(), next)).resolves.toBe('cancelled');
    expect(next).not.toHaveBeenCalled();
  });

  it('hands a session the engine will not route to the desktop', async () => {
    respond({ ok: false, error: 'session is not currently connected to Feishu: session-1' }, false);
    const { listener } = install();
    const next = vi.fn(async () => 'allowed-once');

    await expect(listener(request(), next)).resolves.toBe('allowed-once');
    expect(next).toHaveBeenCalledOnce();
  });

  it('hands the request to the desktop when the engine is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as never;
    const { listener } = install();
    const next = vi.fn(async () => 'allowed-once');

    await expect(listener(request(), next)).resolves.toBe('allowed-once');
    expect(next).toHaveBeenCalledOnce();
  });

  it('calls no answerer at all when the bridge is not configured', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const { listener } = install({});
    const next = vi.fn(async () => 'unavailable');

    await expect(listener(request(), next)).resolves.toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('short-circuits a request DSH already withdrew', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const { listener } = install();
    const next = vi.fn(async () => 'allowed-once');

    await expect(listener(request({ signal: AbortSignal.abort() }), next)).resolves.toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('does not install a tools/pre-execute gate', () => {
    const { events } = install();
    expect(events).toEqual(['approval/request']);
  });
});
