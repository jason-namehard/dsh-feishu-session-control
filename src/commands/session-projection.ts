import { randomUUID } from 'node:crypto';
import {
  renderSessionBindingConfirmCard,
  renderSessionSelectorCard,
  type SessionActionIdentity,
} from '../card/session-projection-card.js';
import { bilingualMarkdown } from '../card/i18n.js';
import type { AccessManager } from '../config/access-manager.js';
import type { SessionStore } from '../session/store.js';
import type { ScopeDirectory } from '../bridge/scope-directory.js';
import { memberOwnerForScope } from '../bridge/scope-isolation.js';
import type { CommandChannel, CommandContext } from './index.js';
import type { PreparedSessionBinding, SessionProjectionBridge } from '../session/projection-bridge.js';
import type { SessionProjectionStore } from '../session/projection-store.js';
import type { SessionAliasManager } from '../session/alias-manager.js';
import { renderSessionDeleteConfirmCard } from '../card/session-alias-card.js';

interface PendingBinding {
  nonce: string;
  actorId: string;
  scope: string;
  workspaceCwd: string;
  chatId: string;
  threadId?: string;
  prepared: PreparedSessionBinding;
  expectedOwner?: { scope: string; workspaceCwd: string };
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface PendingDeletion {
  nonce: string;
  alias: string;
  sessionId: string;
  session: import('../session/projection-protocol.js').DshSessionSummary;
  mode: 'trash' | 'purge';
  actorId: string;
  scope: string;
  workspaceCwd: string;
  chatId: string;
  threadId?: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export interface SessionProjectionActionResult {
  toast: { type: 'success' | 'info' | 'error'; content: string };
  /**
   * Markdown for the spent card's outcome, when the action was terminal.
   *
   * The channel settles the card with it — replying, then recalling — rather
   * than patching the card in place: `im.v1.message.patch` returns its failure
   * as a response code the SDK never raises, so a patch that does nothing is
   * indistinguishable from one that worked. Reply-and-recall is the path the
   * approval and /upgrade cards already take, and it is visibly correct.
   */
  settle?: string;
}

export interface SessionProjectionActionInput {
  value: Record<string, unknown>;
  operatorId: string | undefined;
  chatId: string;
  threadId: string | undefined;
  currentScope: string;
  /** The card the button was pressed on, so its outcome can replace it. */
  messageId?: string;
}

/** Explicit selector/confirmation workflow; no external activity can call bind. */
export class SessionProjectionController {
  private readonly pending = new Map<string, PendingBinding>();
  private readonly pendingDeletions = new Map<string, PendingDeletion>();

  constructor(private readonly deps: {
    bridge: SessionProjectionBridge;
    store: SessionProjectionStore;
    sessions: SessionStore;
    scopes: ScopeDirectory;
    access: AccessManager;
    channel: CommandChannel;
    aliases?: SessionAliasManager;
    confirmationTtlMs?: number;
    selectorLimit?: number;
  }) {}

  async handleCommand(args: string, ctx: CommandContext): Promise<void> {
    const actorId = this.requireAuthorized(ctx.scope, ctx.chatId, ctx.chatMode, ctx.senderId);
    const workspaceCwd = ctx.workspaces.cwdFor(ctx.scope) ?? ctx.defaultWorkspace;
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === 'current') {
      const current = this.deps.store.get(ctx.scope, workspaceCwd);
      await ctx.channel.sendMarkdown(ctx.chatId, current
        ? bilingualMarkdown(
            `当前显式绑定：\`${current.sessionId}\`\n\nscope：\`${ctx.scope}\`\nworkspace：\`${workspaceCwd}\``,
            `Current explicit binding: \`${current.sessionId}\`\n\nscope: \`${ctx.scope}\`\nworkspace: \`${workspaceCwd}\``,
          )
        : bilingualMarkdown('当前 scope + workspace 尚未绑定 DSH session。', 'No DSH session is bound to this scope + workspace.'),
      this.options(ctx.threadId));
      return;
    }
    const requestedId = tokens[0] === 'bind' ? tokens[1] : undefined;
    if (tokens.length > 0 && !requestedId) {
      throw new Error('用法：/session [current|bind <sessionId>]');
    }
    if (requestedId) {
      await this.prepareConfirmation({
        sessionId: requestedId,
        identity: { scope: ctx.scope, workspaceCwd, actorId },
        chatId: ctx.chatId,
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
      });
      return;
    }
    const sessions = (await this.deps.bridge.eligibleSessions(workspaceCwd)).slice(0, this.deps.selectorLimit ?? 10);
    if (sessions.length === 0) {
      await ctx.channel.sendMarkdown(ctx.chatId, bilingualMarkdown(
        '当前 canonical workspace 没有可绑定的普通 DSH session。',
        'No selectable regular DSH session exists in the current canonical workspace.',
      ), this.options(ctx.threadId));
      return;
    }
    if (!ctx.channel.sendCard) throw new Error('当前渠道不支持 session 选择卡片');
    await ctx.channel.sendCard(ctx.chatId, renderSessionSelectorCard({
      sessions,
      identity: { scope: ctx.scope, workspaceCwd, actorId },
    }), this.options(ctx.threadId));
  }

  async handleAliasCommand(command: 'sessions' | 'use' | 'delete' | 'purge', args: string, ctx: CommandContext): Promise<void> {
    if (!this.deps.aliases) throw new Error('session aliases are not configured');
    const actorId = this.requireAuthorized(ctx.scope, ctx.chatId, ctx.chatMode, ctx.senderId);
    const alias = args.trim().split(/\s+/u).filter(Boolean)[0];
    if (command !== 'sessions' && !alias) {
      throw new Error(`Usage: /${command} <MMDD-N>`);
    }
    if (command === 'sessions') {
      if (args.trim()) throw new Error('Usage: /sessions');
      const sessions = await this.deps.bridge.listSessions();
      await this.deps.aliases.syncSessions(sessions.map((session) => ({
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
      })));
      const byId = new Map(sessions.map((session) => [session.sessionId, session]));
      const entries = this.deps.aliases.entries().filter((entry) => byId.has(entry.sessionId));
      // Which session this chat is bound to right now. Without it the list is
      // a set of options with no "you are here", so there is no way to tell
      // what /use would be switching away from.
      const boundCwd = ctx.workspaces.cwdFor(ctx.scope) ?? ctx.defaultWorkspace;
      const boundSessionId = this.deps.store.get(ctx.scope, boundCwd)?.sessionId;
      // Rendered once, not bilingually: every line is aliases, titles and ids,
      // which read identically in both languages, so a bilingual list repeated
      // the whole thing and looked like the bot had sent two cards.
      const lines = ['**DSH 会话列表 · Sessions**', ''];
      if (entries.length === 0) {
        lines.push('暂无可用会话 · No sessions available.');
      } else {
        let currentDate = '';
        for (const entry of entries) {
          const datePrefix = entry.alias.slice(0, 4);
          if (datePrefix !== currentDate) {
            currentDate = datePrefix;
            lines.push(`**${datePrefix}**`);
          }
          const session = byId.get(entry.sessionId)!;
          const title = session.title?.trim() || '未命名会话 · untitled';
          const status = session.trashed
            ? '🗑 回收站'
            : session.running ? '▶ 运行中' : '· 空闲';
          const here = entry.sessionId === boundSessionId ? ' ← **当前对话**' : '';
          lines.push(`- \`${entry.alias}\` · **${title}** · ${status}${here}`);
        }
        if (boundSessionId === undefined) {
          lines.push('', '当前对话尚未绑定会话，用 `/use <别名>` 绑定一个。');
        }
      }
      await ctx.channel.sendMarkdown(
        ctx.chatId,
        lines.join('\n'),
        this.options(ctx.threadId),
      );
      return;
    }
    const sessionId = this.deps.aliases.getSessionId(alias!);
    if (!sessionId) throw new Error(`alias not found: ${alias}`);
    const session = (await this.deps.bridge.listSessions()).find((item) => item.sessionId === sessionId);
    if (!session) {
      await this.deps.aliases.removeAlias(alias!);
      throw new Error(`session for alias ${alias} was already deleted`);
    }
    if (command === 'use' && session.trashed) {
      throw new Error(`alias ${alias} is in the recycle bin; restore it from the DSH Web session manager first`);
    }
    if (command === 'delete' && session.trashed) {
      throw new Error(`alias ${alias} is already in the recycle bin; use /purge ${alias} for permanent deletion`);
    }
    const workspaceCwd = ctx.workspaces.cwdFor(ctx.scope) ?? ctx.defaultWorkspace;
    if (command === 'use') {
      if (session.cwd && session.cwd !== workspaceCwd) {
        throw new Error(`alias ${alias} belongs to workspace ${session.cwd}; switch workspace first`);
      }
      await this.prepareConfirmation({
        sessionId,
        identity: { scope: ctx.scope, workspaceCwd, actorId },
        chatId: ctx.chatId,
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
      });
      return;
    }
    await this.prepareDeletion({
      alias: alias!,
      session,
      mode: command === 'purge' ? 'purge' : 'trash',
      actorId,
      scope: ctx.scope,
      workspaceCwd,
      chatId: ctx.chatId,
      ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    });
  }

  async createNewSession(ctx: CommandContext, workspaceCwd: string): Promise<string> {
    if (!this.deps.aliases) throw new Error('session aliases are not configured');
    const sessionId = await this.deps.bridge.createSession(workspaceCwd);
    const alias = await this.deps.aliases.registerSession(sessionId);
    this.deps.sessions.clearSessionElsewhere(sessionId, ctx.scope, workspaceCwd);
    this.deps.sessions.set(ctx.scope, sessionId, workspaceCwd);
    return alias;
  }

  async handleAction(input: SessionProjectionActionInput): Promise<SessionProjectionActionResult> {
    if (input.value.cmd === 'session-alias') return this.handleAliasAction(input);
    this.pruneExpired();
    const action = typeof input.value.action === 'string' ? input.value.action : '';
    const requestedScope = typeof input.value.scope === 'string' ? input.value.scope : '';
    const workspaceCwd = typeof input.value.workspaceCwd === 'string' ? input.value.workspaceCwd : '';
    const cardActor = typeof input.value.actorId === 'string' ? input.value.actorId : '';
    if (!input.operatorId || input.operatorId !== cardActor || requestedScope !== input.currentScope) {
      return { toast: { type: 'error', content: '身份或 scope 不匹配 / Operator or scope mismatch' } };
    }
    const entry = this.deps.scopes.entry(requestedScope);
    const mode = entry?.chatMode ?? (input.threadId ? 'topic' : 'group');
    try {
      this.requireAuthorized(requestedScope, input.chatId, mode, input.operatorId);
      if (action === 'select') {
        // Not terminal: the selector stays, and the confirmation card it opens
        // is the one that settles.
        const sessionId = typeof input.value.sessionId === 'string' ? input.value.sessionId : '';
        if (!sessionId || !workspaceCwd) throw new Error('invalid session selection');
        await this.prepareConfirmation({
          sessionId,
          identity: { scope: requestedScope, workspaceCwd, actorId: input.operatorId },
          chatId: input.chatId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        });
        return { toast: { type: 'info', content: '请检查披露范围并确认 / Review and confirm disclosure' } };
      }
      const nonce = typeof input.value.nonce === 'string' ? input.value.nonce : '';
      const pending = this.pending.get(nonce);
      if (!pending || pending.expiresAt <= Date.now() ||
          pending.actorId !== input.operatorId || pending.scope !== requestedScope ||
          pending.workspaceCwd !== workspaceCwd || pending.chatId !== input.chatId ||
          pending.threadId !== input.threadId) {
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(nonce);
        throw new Error('confirmation expired or no longer matches its original target');
      }
      if (action === 'cancel') {
        clearTimeout(pending.timer);
        this.pending.delete(nonce);
        return {
          toast: { type: 'info', content: '已取消，绑定未改变 / Cancelled; binding unchanged' },
          settle: bilingualMarkdown('已取消，绑定未改变。', 'Cancelled; the binding is unchanged.'),
        };
      }
      if (action !== 'confirm') throw new Error('unknown session action');
      clearTimeout(pending.timer);
      this.pending.delete(nonce); // one-shot before any asynchronous side effect
      await this.deps.bridge.bindConfirmed({
        scope: pending.scope,
        workspaceCwd: pending.workspaceCwd,
        chatId: pending.chatId,
        ...(pending.threadId ? { threadId: pending.threadId } : {}),
        prepared: pending.prepared,
        // Switching a chat to another session must not replay that session's
        // transcript into Feishu. Someone runs /use because they already know
        // what the other window did; re-reading it back at them buries the
        // chat and costs context for nothing. The binding still starts from
        // the same snapshot cursor, so live messages continue from here.
        deliverHistory: false,
        ...(this.deps.access.isAdmin(pending.actorId) ? { allowCrossScopeMigration: true } : {}),
        ...(pending.expectedOwner ? { expectedOwner: pending.expectedOwner } : {}),
        onBindingCommitted: () => {
          // ProjectionStore is now the exclusive authority. Switch the legacy
          // run-flow mapping synchronously before any transcript/catch-up I/O.
          this.deps.sessions.clearSessionElsewhere(
            pending.prepared.session.sessionId,
            pending.scope,
            pending.workspaceCwd,
          );
          this.deps.sessions.set(pending.scope, pending.prepared.session.sessionId, pending.workspaceCwd);
        },
      });
      const title = pending.prepared.session.title?.trim() || pending.prepared.session.sessionId;
      return {
        toast: { type: 'success', content: '已切换会话 / Session switched' },
        settle: bilingualMarkdown(
          `✅ 已切换到 **${title}**，后续消息都发往这个会话（不回填历史）。`,
          `✅ Switched to **${title}**. Later messages go to this session; no history was replayed.`,
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toast: { type: 'error', content: message },
        settle: bilingualMarkdown(`⚠️ 操作失败：${message}`, `⚠️ Failed: ${message}`),
      };
    }
  }

  rehydrateSessionMappings(): void {
    for (const binding of this.deps.store.list()) {
      this.deps.sessions.clearSessionElsewhere(binding.sessionId, binding.scope, binding.workspaceCwd);
      this.deps.sessions.set(binding.scope, binding.sessionId, binding.workspaceCwd);
    }
  }

  current(scope: string, workspaceCwd: string) {
    return this.deps.store.get(scope, workspaceCwd);
  }

  close(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    for (const pending of this.pendingDeletions.values()) clearTimeout(pending.timer);
    this.pendingDeletions.clear();
  }

  private async handleAliasAction(input: SessionProjectionActionInput): Promise<SessionProjectionActionResult> {
    this.pruneExpired();
    if (!this.deps.aliases) return { toast: { type: 'error', content: 'session aliases are not configured' } };
    const action = typeof input.value.action === 'string' ? input.value.action : '';
    const alias = typeof input.value.alias === 'string' ? input.value.alias : '';
    const requestedScope = typeof input.value.scope === 'string' ? input.value.scope : '';
    const workspaceCwd = typeof input.value.workspaceCwd === 'string' ? input.value.workspaceCwd : '';
    const cardActor = typeof input.value.actorId === 'string' ? input.value.actorId : '';
    if (!input.operatorId || input.operatorId !== cardActor || requestedScope !== input.currentScope) {
      return { toast: { type: 'error', content: 'operator or scope mismatch' } };
    }
    const entry = this.deps.scopes.entry(requestedScope);
    const mode = entry?.chatMode ?? (input.threadId ? 'topic' : 'group');
    try {
      this.requireAuthorized(requestedScope, input.chatId, mode, input.operatorId);
      const nonce = typeof input.value.nonce === 'string' ? input.value.nonce : '';
      const pending = this.pendingDeletions.get(nonce);
      if (!pending || pending.expiresAt <= Date.now() || pending.alias !== alias ||
          pending.actorId !== input.operatorId || pending.scope !== requestedScope ||
          pending.workspaceCwd !== workspaceCwd || pending.chatId !== input.chatId ||
          pending.threadId !== input.threadId) {
        if (pending) clearTimeout(pending.timer);
        this.pendingDeletions.delete(nonce);
        throw new Error('confirmation expired or no longer matches its original target');
      }
      clearTimeout(pending.timer);
      this.pendingDeletions.delete(nonce);
      if (action === 'delete-cancel') {
        return {
          toast: { type: 'info', content: 'Cancelled; session was not deleted' },
          settle: bilingualMarkdown('已取消，会话未被删除。', 'Cancelled; the session was not deleted.'),
        };
      }
      if (action !== 'delete-confirm') throw new Error('unknown session deletion action');
      if (this.deps.aliases.getSessionId(pending.alias) !== pending.sessionId) {
        throw new Error(`alias mapping changed; send /${pending.mode} again`);
      }
      const current = (await this.deps.bridge.listSessions()).find((item) => item.sessionId === pending.sessionId);
      if (!current) {
        await this.deps.aliases.removeAlias(pending.alias);
        throw new Error(`session for alias ${pending.alias} was already deleted`);
      }
      if (pending.mode === 'purge') await this.deps.bridge.purgeSession(pending.sessionId);
      else await this.deps.bridge.deleteSession(pending.sessionId);
      this.deps.sessions.clearSessionId(pending.sessionId);
      await this.deps.store.removeSession(pending.sessionId);
      const title = pending.session.title?.trim() || pending.alias;
      if (pending.mode === 'purge') {
        await this.deps.aliases.removeAlias(pending.alias);
        return {
          toast: { type: 'success', content: `Permanently deleted session ${pending.alias}` },
          settle: bilingualMarkdown(
            `❌ 已永久删除 \`${pending.alias}\` · **${title}**，无法恢复。`,
            `❌ Permanently deleted \`${pending.alias}\` · **${title}**. This cannot be undone.`,
          ),
        };
      }
      return {
        toast: { type: 'success', content: `Moved session ${pending.alias} to the recycle bin` },
        settle: bilingualMarkdown(
          `🗑 已移入回收站：\`${pending.alias}\` · **${title}**，可在 DSH Web 会话管理器恢复。`,
          `🗑 Moved \`${pending.alias}\` · **${title}** to the recycle bin; restore it from the DSH Web session manager.`,
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toast: { type: 'error', content: message },
        settle: bilingualMarkdown(`⚠️ 操作失败：${message}`, `⚠️ Failed: ${message}`),
      };
    }
  }


  private async prepareConfirmation(input: {
    sessionId: string;
    identity: SessionActionIdentity;
    chatId: string;
    threadId?: string;
  }): Promise<void> {
    const ownerBeforeRead = this.deps.store.ownerOf(input.sessionId);
    if (ownerBeforeRead && ownerBeforeRead.scope !== input.identity.scope &&
        !this.deps.access.isAdmin(input.identity.actorId)) {
      throw new Error('该 session 已绑定其他飞书 scope；独占迁移仅 profile 管理员可确认');
    }
    const prepared = await this.deps.bridge.prepare(input.sessionId, input.identity.workspaceCwd);
    const owner = this.deps.store.ownerOf(input.sessionId);
    if (owner && owner.scope !== input.identity.scope &&
        !this.deps.access.isAdmin(input.identity.actorId)) {
      throw new Error('该 session 已绑定其他飞书 scope；独占迁移仅 profile 管理员可确认');
    }
    const nonce = randomUUID();
    const expiresAt = Date.now() + (this.deps.confirmationTtlMs ?? 10 * 60_000);
    const timer = setTimeout(() => this.pending.delete(nonce), expiresAt - Date.now());
    timer.unref?.();
    const pending: PendingBinding = {
      nonce,
      actorId: input.identity.actorId,
      scope: input.identity.scope,
      workspaceCwd: input.identity.workspaceCwd,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      prepared,
      ...(owner ? { expectedOwner: { scope: owner.scope, workspaceCwd: owner.workspaceCwd } } : {}),
      expiresAt,
      timer,
    };
    this.pending.set(nonce, pending);
    if (!this.deps.channel.sendCard) throw new Error('当前渠道不支持确认卡片');
    const current = this.deps.store.get(input.identity.scope, input.identity.workspaceCwd);
    await this.deps.channel.sendCard(input.chatId, renderSessionBindingConfirmCard({
      nonce,
      session: prepared.session,
      identity: input.identity,
      backfillCount: prepared.backfillCount,
      ...(current && current.sessionId !== input.sessionId ? { replacesScopeSession: current.sessionId } : {}),
      ...(owner && owner.scope !== input.identity.scope ? { migratesFromScope: owner.scope } : {}),
    }), this.options(input.threadId));
  }

  private async prepareDeletion(input: {
    alias: string;
    session: import('../session/projection-protocol.js').DshSessionSummary;
    mode: 'trash' | 'purge';
    actorId: string;
    scope: string;
    workspaceCwd: string;
    chatId: string;
    threadId?: string;
  }): Promise<void> {
    if (!this.deps.aliases) throw new Error('session aliases are not configured');
    const owner = this.deps.store.ownerOf(input.session.sessionId);
    const localOwner = this.deps.sessions.scopeForSession(input.session.sessionId);
    if ((owner && owner.scope !== input.scope || localOwner && localOwner !== input.scope) &&
        !this.deps.access.isAdmin(input.actorId)) {
      throw new Error('this session belongs to another Feishu scope; only a profile administrator may delete it');
    }
    const nonce = randomUUID();
    const expiresAt = Date.now() + (this.deps.confirmationTtlMs ?? 10 * 60_000);
    const timer = setTimeout(() => this.pendingDeletions.delete(nonce), expiresAt - Date.now());
    timer.unref?.();
    this.pendingDeletions.set(nonce, {
      nonce,
      alias: input.alias,
      sessionId: input.session.sessionId,
      session: input.session,
      mode: input.mode,
      actorId: input.actorId,
      scope: input.scope,
      workspaceCwd: input.workspaceCwd,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      expiresAt,
      timer,
    });
    if (!this.deps.channel.sendCard) throw new Error('current channel does not support confirmation cards');
    await this.deps.channel.sendCard(input.chatId, renderSessionDeleteConfirmCard({
      alias: input.alias,
      session: input.session,
      mode: input.mode,
      nonce,
      scope: input.scope,
      workspaceCwd: input.workspaceCwd,
      actorId: input.actorId,
    }), this.options(input.threadId));
  }

  private requireAuthorized(
    scope: string,
    chatId: string,
    chatMode: 'p2p' | 'group' | 'topic',
    senderId: string | undefined,
  ): string {
    if (!senderId) throw new Error('无法确认操作者身份');
    if (scope !== chatId && !scope.startsWith(`${chatId}:`)) throw new Error('scope 不属于当前聊天');
    const access = this.deps.access.snapshot();
    if (access.allowedUsers.length > 0 && !access.allowedUsers.includes(senderId)) {
      throw new Error('操作者不在当前用户白名单中');
    }
    if (chatMode !== 'p2p' && access.allowedChats.length > 0 && !access.allowedChats.includes(chatId)) {
      throw new Error('当前聊天不在群聊白名单中');
    }
    const memberOwner = memberOwnerForScope(scope, chatId);
    if (memberOwner) {
      if (memberOwner !== senderId) throw new Error('member scope 只能由其本人绑定');
      return senderId;
    }
    if (chatMode === 'p2p') return senderId;
    if (!this.deps.access.isAdmin(senderId)) throw new Error('群聊/话题共享绑定仅管理员可切换');
    return senderId;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [nonce, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        clearTimeout(pending.timer);
        this.pending.delete(nonce);
      }
    }
    for (const [nonce, pending] of this.pendingDeletions) {
      if (pending.expiresAt <= now) {
        clearTimeout(pending.timer);
        this.pendingDeletions.delete(nonce);
      }
    }
  }

  private options(threadId: string | undefined): { threadId: string } | undefined {
    return threadId ? { threadId } : undefined;
  }
}
