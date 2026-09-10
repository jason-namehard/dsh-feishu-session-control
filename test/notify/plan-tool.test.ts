import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/notify/plan-tool.js';
import type { RawToolDefinition } from '../../src/notify/raw-tool.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('lark_request_plan_approval tool', () => {
  it('registers only an optional decision tool and no execution gate', () => {
    const events: string[] = [];
    const register = vi.fn();
    apply({
      on: (event: string) => events.push(event),
      tools: { register },
    } as never);
    expect(events).toEqual([]);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toMatchObject({ name: 'lark_request_plan_approval' });
  });

  it('posts a genuine plan decision and returns the selected result', async () => {
    const register = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, decision: 'approved', feedback: 'continue' }),
    }) as never;
    apply({ tools: { register } } as never, {
      endpoint: 'http://127.0.0.1/plan', token: 'secret',
    });
    const tool = register.mock.calls[0]?.[0] as RawToolDefinition;
    const result = await tool.execute(
      { plan: 'Choose implementation A or B' },
      { agent: { session: { id: 'session-1' } } } as never,
    );
    expect(result).toEqual({ resolved: true, decision: 'approved', feedback: 'continue' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1/plan',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: 'secret', sessionId: 'session-1', plan: 'Choose implementation A or B',
        }),
      }),
    );
  });

  it('does not describe ordinary tool execution as requiring this card', () => {
    const register = vi.fn();
    apply({ tools: { register } } as never);
    const tool = register.mock.calls[0]?.[0] as RawToolDefinition;
    expect(tool.description).toContain('genuinely ambiguous');
    expect(tool.description).toContain('must not be blocked');
  });
});
