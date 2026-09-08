import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AccessManager } from '../../src/config/access-manager.js';
import type { CommandContext } from '../../src/commands/index.js';
import { SessionProjectionController } from '../../src/commands/session-projection.js';
import { ScopeDirectory } from '../../src/bridge/scope-directory.js';
import type { SessionProjectionBridge } from '../../src/session/projection-bridge.js';
import { SessionProjectionStore } from '../../src/session/projection-store.js';
import { SessionStore } from '../../src/session/store.js';
import { SessionAliasManager } from '../../src/session/alias-manager.js';

async function fixture(
  admins: string[] = [],
  allowedUsers: string[] = [],
  allowedChats: string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-session-command-'));
  const store = new SessionProjectionStore(join(root, 'projection.json'));
  const sessions = new SessionStore(join(root, 'sessions.json'));
  const scopes = new ScopeDirectory(join(root, 'scopes.json'));
  const aliases = new SessionAliasManager(join(root, 'aliases.json'), () => new Date(2026, 8, 5));
  await Promise.all([store.load(), sessions.load(), scopes.load(), aliases.load()]);
  const session = { sessionId: 's1', updatedAt: new Date(2026, 8, 5).getTime(), running: false, blank: false, cwd: '/repo', title: 'Release' };
  let trashed = false;
  let deleted = false;
  const prepared = { session, messages: [{ role: 'user' as const, content: 'secret history', source: 'other-dsh-client' as const }], backfillCount: 1, truncated: false, snapshotSeq: 5 };
  const bridge = {
    eligibleSessions: vi.fn(async () => [session]),
    listSessions: vi.fn(async () => deleted ? [] : [{ ...session, ...(trashed ? { trashed: true } : {}) }]),
    createSession: vi.fn(async () => 's2'),
    deleteSession: vi.fn(async () => { trashed = true; return { ok: true, trashed: true }; }),
    renameSession: vi.fn(async (_id: string, title: string) => title.trim().slice(0, 40)),
    purgeSession: vi.fn(async () => { deleted = true; return { ok: true, purged: true }; }),
    prepare: vi.fn(async () => prepared),
    bindConfirmed: vi.fn(async (input: Parameters<SessionProjectionBridge['bindConfirmed']>[0]) => {
      const result = await store.bindExclusive({
        scope: input.scope,
        workspaceCwd: input.workspaceCwd,
        sessionId: input.prepared.session.sessionId,
        chatId: input.chatId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        initialSeq: input.prepared.snapshotSeq,
        ...(input.allowCrossScopeMigration ? { allowCrossScopeMigration: true } : {}),
        ...(input.expectedOwner ? { expectedOwner: input.expectedOwner } : {}),
      });
      input.onBindingCommitted?.(result);
      return { ...result, transcriptDelivered: true };
    }),
  } as unknown as SessionProjectionBridge;
  const sendCard = vi.fn(async (_chatId: string, _card: object) => 'card');
  const sendMarkdown = vi.fn(async () => undefined);
  const updateCard = vi.fn(async (_messageId: string, _card: object) => undefined);
  const access = {
    isAdmin: (id: string | undefined) => !!id && admins.includes(id),
    snapshot: () => ({ admins: [...admins], allowedUsers: [...allowedUsers], allowedChats: [...allowedChats] }),
  } as AccessManager;
  const controller = new SessionProjectionController({
    bridge, store, sessions, scopes, access,
    channel: { sendCard, sendMarkdown, updateCard },
    aliases,
  });
  return { controller, bridge, store, sessions, scopes, aliases, sendCard, sendMarkdown, updateCard, prepared };
}

function commandContext(input: {
  controller: SessionProjectionController;
  scope: string;
  chatId: string;
  chatMode: 'p2p' | 'group' | 'topic';
  senderId: string;
}) {
  return {
    scope: input.scope,
    chatId: input.chatId,
    chatMode: input.chatMode,
    senderId: input.senderId,
    threadId: input.chatMode === 'topic' ? 'thread-a' : undefined,
    defaultWorkspace: '/repo',
    workspaces: { cwdFor: () => '/repo' },
    channel: (input.controller as unknown as { deps: { channel: unknown } }).deps.channel,
    sessionProjection: input.controller,
  } as unknown as CommandContext;
}

describe('session alias commands', () => {
  it('lists stable aliases and creates a native session for /new-style callers', async () => {
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    await f.controller.handleAliasCommand('sessions', '', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));
    expect(f.sendMarkdown).toHaveBeenCalledWith('chat-a', expect.stringContaining('0905-1'), undefined);

    const alias = await f.controller.createNewSession(commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }), '/repo');
    expect(alias).toBe('0905-2');
    expect(f.sessions.resumeFor('chat-a', '/repo')).toBe('s2');
  });

  it('moves a session to the recycle bin, then permanently deletes it with /purge', async () => {
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    f.sessions.set('chat-a', 's1', '/repo');
    await f.controller.handleAliasCommand('delete', '0905-1', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));
    const card = JSON.stringify(f.sendCard.mock.calls.at(-1)?.[1]);
    const nonce = [...card.matchAll(/"nonce":"([^"]+)"/gu)][0]?.[1];
    expect(card).toContain('0905-1');
    expect(f.bridge.deleteSession).not.toHaveBeenCalled();

    const result = await f.controller.handleAction({
      value: { cmd: 'session-alias', action: 'delete-confirm', alias: '0905-1', nonce, scope: 'chat-a', workspaceCwd: '/repo', actorId: 'user-a' },
      operatorId: 'user-a', chatId: 'chat-a', threadId: undefined, currentScope: 'chat-a',
    });
    expect(result.toast.type).toBe('success');
    expect(f.bridge.deleteSession).toHaveBeenCalledWith('s1');
    expect(f.aliases.getSessionId('0905-1')).toBe('s1');
    expect(f.sessions.resumeFor('chat-a', '/repo')).toBeUndefined();
    expect(f.store.list()).toHaveLength(0);

    await f.controller.handleAliasCommand('purge', '0905-1', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));
    const purgeCard = JSON.stringify(f.sendCard.mock.calls.at(-1)?.[1]);
    const purgeNonce = [...purgeCard.matchAll(/"nonce":"([^"]+)"/gu)][0]?.[1];
    expect(purgeCard).toContain('0905-1');
    expect(purgeCard).toContain('permanent');

    const purgeResult = await f.controller.handleAction({
      value: { cmd: 'session-alias', action: 'delete-confirm', alias: '0905-1', nonce: purgeNonce, scope: 'chat-a', workspaceCwd: '/repo', actorId: 'user-a', mode: 'purge' },
      operatorId: 'user-a', chatId: 'chat-a', threadId: undefined, currentScope: 'chat-a',
    });
    expect(purgeResult.toast.type).toBe('success');
    expect(f.bridge.purgeSession).toHaveBeenCalledWith('s1');
    expect(f.aliases.getSessionId('0905-1')).toBeUndefined();
  });

  it('reports an outcome for the spent confirmation card, so the channel can settle it', async () => {
    // A card that still shows its buttons after the deletion ran is
    // indistinguishable from one that did nothing: the toast is gone in a
    // second and never says which card it belonged to. The channel settles
    // the card by replying and recalling it — the path approval cards take.
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    await f.controller.handleAliasCommand('delete', '0905-1', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));
    const nonce = [...JSON.stringify(f.sendCard.mock.calls.at(-1)?.[1]).matchAll(/"nonce":"([^"]+)"/gu)][0]?.[1];

    const outcome = await f.controller.handleAction({
      value: { cmd: 'session-alias', action: 'delete-confirm', alias: '0905-1', nonce, scope: 'chat-a', workspaceCwd: '/repo', actorId: 'user-a' },
      operatorId: 'user-a', chatId: 'chat-a', threadId: undefined, currentScope: 'chat-a',
    });

    expect(outcome.settle).toContain('回收站');
    expect(outcome.toast.type).toBe('success');
  });

  it('switches the binding without replaying the other session into the chat', async () => {
    // /use is a routing change. Someone switches because they already know what
    // the other window did; re-posting its transcript buries the chat.
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    await f.controller.handleAliasCommand('use', '0905-1', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));
    const nonce = [...JSON.stringify(f.sendCard.mock.calls.at(-1)?.[1]).matchAll(/"nonce":"([^"]+)"/gu)][0]?.[1];

    const confirmed = await f.controller.handleAction({
      value: { cmd: 'session-projection', action: 'confirm', nonce, scope: 'chat-a', workspaceCwd: '/repo', actorId: 'user-a' },
      operatorId: 'user-a', chatId: 'chat-a', threadId: undefined, currentScope: 'chat-a',
    });

    expect(confirmed.toast.type).toBe('success');
    expect(f.sessions.resumeFor('chat-a', '/repo')).toBe('s1');
    expect(f.bridge.bindConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ deliverHistory: false }),
    );
    // And the pending card has an outcome to be settled with.
    expect(confirmed.settle).toContain('已切换');
  });

  it('names a session straight from /rename, and through the card when no name is typed', async () => {
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    const ctx = commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    });

    // With a name, it is set outright — one message, no card to press.
    await f.controller.handleRenameCommand('0905-1 登录接口重构', ctx);
    expect(f.bridge.renameSession).toHaveBeenCalledWith('s1', '登录接口重构');
    expect(f.sendMarkdown).toHaveBeenCalledWith('chat-a', expect.stringContaining('登录接口重构'), undefined);

    // Without one, the card carries the alias so only the name has to be typed.
    await f.controller.handleRenameCommand('0905-1', ctx);
    const card = JSON.stringify(f.sendCard.mock.calls.at(-1)?.[1]);
    expect(card).toContain('"cmd":"session-rename"');
    expect(card).toContain('"tag":"input"');
    expect(card).toContain('0905-1');
    const nonce = [...card.matchAll(/"nonce":"([^"]+)"/gu)][0]?.[1];

    const named = await f.controller.handleAction({
      value: { cmd: 'session-rename', action: 'rename-submit', alias: '0905-1', nonce, scope: 'chat-a', workspaceCwd: '/repo', actorId: 'user-a' },
      operatorId: 'user-a', chatId: 'chat-a', threadId: undefined, currentScope: 'chat-a',
      formValue: { title: '  发布流程  ' },
    });
    expect(f.bridge.renameSession).toHaveBeenLastCalledWith('s1', '发布流程');
    expect(named.settle).toContain('发布流程');
  });

  it('treats an empty name submit as keeping dsh own naming', async () => {
    // The card has to accept "no opinion": an empty submit is a real answer,
    // not a validation error to bounce back.
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    await f.controller.handleRenameCommand('0905-1', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));
    const nonce = [...JSON.stringify(f.sendCard.mock.calls.at(-1)?.[1]).matchAll(/"nonce":"([^"]+)"/gu)][0]?.[1];

    const outcome = await f.controller.handleAction({
      value: { cmd: 'session-rename', action: 'rename-submit', alias: '0905-1', nonce, scope: 'chat-a', workspaceCwd: '/repo', actorId: 'user-a' },
      operatorId: 'user-a', chatId: 'chat-a', threadId: undefined, currentScope: 'chat-a',
      formValue: { title: '   ' },
    });

    expect(f.bridge.renameSession).not.toHaveBeenCalled();
    expect(outcome.toast.type).toBe('info');
    expect(outcome.settle).toContain('默认命名');
  });

  it('refuses a naming card replayed by someone else', async () => {
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    await f.controller.handleRenameCommand('0905-1', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));
    const nonce = [...JSON.stringify(f.sendCard.mock.calls.at(-1)?.[1]).matchAll(/"nonce":"([^"]+)"/gu)][0]?.[1];

    const stolen = await f.controller.handleAction({
      value: { cmd: 'session-rename', action: 'rename-submit', alias: '0905-1', nonce, scope: 'chat-a', workspaceCwd: '/repo', actorId: 'user-a' },
      operatorId: 'user-b', chatId: 'chat-a', threadId: undefined, currentScope: 'chat-a',
      formValue: { title: 'not mine' },
    });

    expect(stolen.toast.type).toBe('error');
    expect(f.bridge.renameSession).not.toHaveBeenCalled();
  });

  it('marks the session a chat is actually on, even when no /use ever confirmed it', async () => {
    // A brand-new chat mints a session on its first message: dsh creates it,
    // the Web UI lists it, and the run-flow records it — but nothing was
    // *confirmed*, so the projection store is empty. Reading only that store
    // made /sessions mark nothing and say "not bound", while the chat had been
    // using that session all along; it only looked right after a /use.
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    f.sessions.set('chat-a', 's1', '/repo');
    expect(f.store.get('chat-a', '/repo')).toBeUndefined();

    await f.controller.handleAliasCommand('sessions', '', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));

    const listing = f.sendMarkdown.mock.calls.at(-1)?.[1] as unknown as string;
    expect(listing).toContain('← **当前对话**');
    expect(listing).not.toContain('还没有会话');
  });

  it('says so when the chat is on a session the alias list does not cover', async () => {
    // Silently marking nothing is indistinguishable from "not bound", which is
    // the confusion this whole fix is about.
    const f = await fixture();
    f.scopes.register('chat-a', 'chat-a', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    f.sessions.set('chat-a', 'session-from-another-workspace', '/repo');

    await f.controller.handleAliasCommand('sessions', '', commandContext({
      controller: f.controller, scope: 'chat-a', chatId: 'chat-a', chatMode: 'p2p', senderId: 'user-a',
    }));

    const listing = f.sendMarkdown.mock.calls.at(-1)?.[1] as unknown as string;
    expect(listing).toContain('不在上面的列表里');
    expect(listing).toContain('session-from-another-workspace');
  });

  it('requires profile admin for group/topic but permits the owner of a member scope', async () => {
    const f = await fixture();
    await expect(f.controller.handleAliasCommand('sessions', '', commandContext({
      controller: f.controller, scope: 'chat-g', chatId: 'chat-g', chatMode: 'group', senderId: 'member-a',
    }))).rejects.toThrow('仅管理员');
    f.scopes.register('chat-g:member:member-a', 'chat-g', undefined, 'group', 'incoming');
    await expect(f.controller.handleAliasCommand('sessions', '', commandContext({
      controller: f.controller, scope: 'chat-g:member:member-a', chatId: 'chat-g', chatMode: 'group', senderId: 'member-a',
    }))).resolves.toBeUndefined();
    await expect(f.controller.handleAliasCommand('sessions', '', commandContext({
      controller: f.controller, scope: 'chat-g:member:member-a', chatId: 'chat-g', chatMode: 'group', senderId: 'member-b',
    }))).rejects.toThrow('本人');
  });

  it('freezes actor/scope/workspace in a one-shot confirmation and binds only after confirm', async () => {
    const f = await fixture(['admin-a']);
    f.scopes.register('chat-g:thread-a', 'chat-g', 'thread-a', 'topic', 'incoming');
    await f.aliases.registerSession('s1');
    await f.controller.handleAliasCommand('use', '0905-1', {
      ...commandContext({
        controller: f.controller, scope: 'chat-g:thread-a', chatId: 'chat-g', chatMode: 'topic', senderId: 'admin-a',
      }),
    });
    expect(f.bridge.bindConfirmed).not.toHaveBeenCalled();
    const confirmation = f.sendCard.mock.calls[0]?.[1];
    const serialized = JSON.stringify(confirmation);
    expect(serialized).not.toContain('secret history');
    expect(serialized).toContain('该会话已有消息');
    const nonce = [...serialized.matchAll(/"nonce":"([^"]+)"/g)][0]?.[1];
    expect(nonce).toBeTruthy();

    const wrongActor = await f.controller.handleAction({
      value: { cmd: 'session-projection', action: 'confirm', nonce, scope: 'chat-g:thread-a', workspaceCwd: '/repo', actorId: 'admin-a' },
      operatorId: 'admin-b', chatId: 'chat-g', threadId: 'thread-a', currentScope: 'chat-g:thread-a',
    });
    expect(wrongActor.toast.type).toBe('error');
    expect(f.bridge.bindConfirmed).not.toHaveBeenCalled();

    const confirmed = await f.controller.handleAction({
      value: { cmd: 'session-projection', action: 'confirm', nonce, scope: 'chat-g:thread-a', workspaceCwd: '/repo', actorId: 'admin-a' },
      operatorId: 'admin-a', chatId: 'chat-g', threadId: 'thread-a', currentScope: 'chat-g:thread-a',
    });
    expect(confirmed.toast.type).toBe('success');
    expect(f.bridge.bindConfirmed).toHaveBeenCalledOnce();
    expect(f.sessions.resumeFor('chat-g:thread-a', '/repo')).toBe('s1');

    const replayed = await f.controller.handleAction({
      value: { cmd: 'session-projection', action: 'confirm', nonce, scope: 'chat-g:thread-a', workspaceCwd: '/repo', actorId: 'admin-a' },
      operatorId: 'admin-a', chatId: 'chat-g', threadId: 'thread-a', currentScope: 'chat-g:thread-a',
    });
    expect(replayed.toast.type).toBe('error');
    expect(f.bridge.bindConfirmed).toHaveBeenCalledOnce();
  });

  it('does not let an ordinary p2p user migrate another scope exclusive binding', async () => {
    const f = await fixture();
    await f.store.bindExclusive({
      scope: 'chat-old', workspaceCwd: '/repo', sessionId: 's1', chatId: 'chat-old', initialSeq: 5,
    });
    f.scopes.register('chat-new', 'chat-new', undefined, 'p2p', 'incoming');
    await f.aliases.registerSession('s1');
    await expect(f.controller.handleAliasCommand('use', '0905-1', commandContext({
      controller: f.controller, scope: 'chat-new', chatId: 'chat-new', chatMode: 'p2p', senderId: 'user-new',
    }))).rejects.toThrow('仅 profile 管理员');
    expect(f.bridge.prepare).not.toHaveBeenCalled();
    expect(f.store.ownerOf('s1')?.scope).toBe('chat-old');
  });

  it('rechecks current user/chat allowlists for commands and stale card actions', async () => {
    const f = await fixture(['admin-a'], ['admin-a'], ['chat-allowed']);
    await expect(f.controller.handleAliasCommand('sessions', '', commandContext({
      controller: f.controller, scope: 'chat-private', chatId: 'chat-private', chatMode: 'p2p', senderId: 'revoked-user',
    }))).rejects.toThrow('用户白名单');

    f.scopes.register('chat-blocked:thread-a', 'chat-blocked', 'thread-a', 'topic', 'incoming');
    const blocked = await f.controller.handleAction({
      value: {
        cmd: 'session-rename', action: 'rename-submit', alias: '0905-1', nonce: 'stale',
        scope: 'chat-blocked:thread-a', workspaceCwd: '/repo', actorId: 'admin-a',
      },
      operatorId: 'admin-a', chatId: 'chat-blocked', threadId: 'thread-a', currentScope: 'chat-blocked:thread-a',
      formValue: { title: 'from a chat that lost its allowlist entry' },
    });
    expect(blocked.toast).toEqual(expect.objectContaining({ type: 'error', content: expect.stringContaining('群聊白名单') }));
    expect(f.bridge.prepare).not.toHaveBeenCalled();
  });

  it('rejects a stale disclosure and clears the displaced SessionStore mapping after admin migration', async () => {
    const stale = await fixture();
    stale.scopes.register('chat-new', 'chat-new', undefined, 'p2p', 'incoming');
    await stale.aliases.registerSession('s1');
    await stale.controller.handleAliasCommand('use', '0905-1', commandContext({
      controller: stale.controller, scope: 'chat-new', chatId: 'chat-new', chatMode: 'p2p', senderId: 'user-new',
    }));
    const staleCard = JSON.stringify(stale.sendCard.mock.calls[0]?.[1]);
    const staleNonce = [...staleCard.matchAll(/"nonce":"([^"]+)"/g)][0]?.[1];
    await stale.store.bindExclusive({
      scope: 'chat-old', workspaceCwd: '/repo', sessionId: 's1', chatId: 'chat-old', initialSeq: 5,
    });
    const staleResult = await stale.controller.handleAction({
      value: { cmd: 'session-projection', action: 'confirm', nonce: staleNonce, scope: 'chat-new', workspaceCwd: '/repo', actorId: 'user-new' },
      operatorId: 'user-new', chatId: 'chat-new', threadId: undefined, currentScope: 'chat-new',
    });
    expect(staleResult.toast.type).toBe('error');
    expect(stale.store.ownerOf('s1')?.scope).toBe('chat-old');

    const admin = await fixture(['admin-a']);
    admin.scopes.register('chat-new', 'chat-new', undefined, 'p2p', 'incoming');
    await admin.store.bindExclusive({
      scope: 'chat-old', workspaceCwd: '/repo', sessionId: 's1', chatId: 'chat-old', initialSeq: 5,
    });
    admin.sessions.set('chat-old', 's1', '/repo');
    await admin.sessions.flush();
    await admin.aliases.registerSession('s1');
    await admin.controller.handleAliasCommand('use', '0905-1', commandContext({
      controller: admin.controller, scope: 'chat-new', chatId: 'chat-new', chatMode: 'p2p', senderId: 'admin-a',
    }));
    const adminCard = JSON.stringify(admin.sendCard.mock.calls[0]?.[1]);
    const adminNonce = [...adminCard.matchAll(/"nonce":"([^"]+)"/g)][0]?.[1];
    const migrated = await admin.controller.handleAction({
      value: { cmd: 'session-projection', action: 'confirm', nonce: adminNonce, scope: 'chat-new', workspaceCwd: '/repo', actorId: 'admin-a' },
      operatorId: 'admin-a', chatId: 'chat-new', threadId: undefined, currentScope: 'chat-new',
    });
    expect(migrated.toast.type).toBe('success');
    expect(admin.sessions.resumeFor('chat-old', '/repo')).toBeUndefined();
    expect(admin.sessions.resumeFor('chat-new', '/repo')).toBe('s1');
  });
});
