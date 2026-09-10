import { describe, expect, it, vi } from 'vitest';
import { ApprovalRegistry } from '../../src/bot/approvals.js';
import { ScopeDirectory } from '../../src/bridge/scope-directory.js';
import { buildApprovalHandler } from '../../src/notify/approval-handler.js';
import { SessionStore } from '../../src/session/store.js';

function fixture() {
  const sessions = new SessionStore(':memory:');
  sessions.set('chat-a', 'session-1', '/tmp/project');
  const directory = new ScopeDirectory(':memory:');
  directory.register('chat-a', 'chat-a', undefined);
  return { sessions, directory };
}

describe('buildApprovalHandler', () => {
  it('ignores the retired bridge policy and asks for the native request', async () => {
    const { sessions, directory } = fixture();
    const approvals = new ApprovalRegistry();
    const sendCard = vi.fn(async (_chatId: string, _card: object) => 'approval-card');
    const handler = buildApprovalHandler({
      sessions,
      scopeDirectory: directory,
      approvals,
      channel: { sendCard },
    });
    const result = handler({ token: 't', sessionId: 'session-1', toolName: 'bash' });
    await vi.waitFor(() => expect(sendCard).toHaveBeenCalledOnce());
    const card = JSON.stringify(sendCard.mock.calls[0]?.[1]);
    const id = card.match(/approval-[a-z0-9]+/u)?.[0];
    expect(id).toBeTruthy();
    approvals.resolve('chat-a', id!, 'allowed-once');
    await expect(result).resolves.toEqual({ ok: true, owned: true, outcome: 'allowed-once' });
  });

  it('does not route a detached or half-connected Web-origin session', async () => {
    const { sessions, directory } = fixture();
    const sendCard = vi.fn();
    const handler = buildApprovalHandler({
      sessions,
      scopeDirectory: directory,
      approvals: new ApprovalRegistry(),
      canRouteSessionToFeishu: () => false,
      channel: { sendCard },
    });
    await expect(handler({
      token: 't', sessionId: 'session-1', toolName: 'bash',
    })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('not currently connected'),
    });
    // No card was delivered, so the answerer must read this as "desktop owns
    // it" — the `owned` flag has to stay absent, never `false`.
    const denied = await handler({ token: 't', sessionId: 'session-1', toolName: 'bash' });
    expect('owned' in denied).toBe(false);
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('reports a cancelled card as owned so it is never re-asked on the desktop', async () => {
    const { sessions, directory } = fixture();
    const approvals = new ApprovalRegistry();
    const sendCard = vi.fn(async (_chatId: string, _card: object) => 'approval-card');
    const handler = buildApprovalHandler({
      sessions,
      scopeDirectory: directory,
      approvals,
      canRouteSessionToFeishu: () => true,
      channel: { sendCard },
    });
    const controller = new AbortController();
    const result = handler({ token: 't', sessionId: 'session-1', toolName: 'bash' }, controller.signal);
    await vi.waitFor(() => expect(sendCard).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).resolves.toEqual({ ok: true, owned: true, outcome: 'cancelled' });
  });

  it('routes a connected request and returns the chosen decision', async () => {
    const { sessions, directory } = fixture();
    const approvals = new ApprovalRegistry();
    const sendCard = vi.fn(async (_chatId: string, _card: object) => 'approval-card');
    const handler = buildApprovalHandler({
      sessions,
      scopeDirectory: directory,
      approvals,
      canRouteSessionToFeishu: () => true,
      channel: { sendCard },
    });
    const result = handler({
      token: 't', sessionId: 'session-1', toolName: 'bash',
      reason: 'Run tests', toolInput: { command: 'pnpm test' },
    });
    await vi.waitFor(() => expect(sendCard).toHaveBeenCalledOnce());
    const card = JSON.stringify(sendCard.mock.calls[0]?.[1]);
    expect(card).toContain('pnpm test');
    const id = card.match(/approval-[a-z0-9]+/u)?.[0];
    approvals.resolve('chat-a', id!, 'rejected');
    await expect(result).resolves.toMatchObject({
      ok: true,
      outcome: 'rejected',
      denial: { layer: 'dsh-native-approval' },
    });
  });
});
