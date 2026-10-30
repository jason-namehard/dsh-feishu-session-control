import { randomUUID } from 'node:crypto';
import {
  renderSessionBindingConfirmCard,
  renderSessionConnectionModeCard,
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
import type { FeishuConnectionMode } from '../session/projection-store.js';
import type { SessionAliasManager } from '../session/alias-manager.js';
import type { ActiveRuns } from '../bot/active-runs.js';
import type { WorkspaceStore } from '../workspace/store.js';
import {
  renderSessionCandidateCard,
  renderSessionDeleteConfirmCard,
  renderSessionNameCard,
} from '../card/session-alias-card.js';

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

interface PendingRename {
  nonce: string;
  alias: string;
  sessionId: string;
  actorId: string;
  scope: string;
  workspaceCwd: string;
  chatId: string;
  threadId?: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface PendingConnectionMode {
  nonce: string;
  actorId: string;
  scope: string;
  workspaceCwd: string;
  sessionId: string;
  chatId: string;
  threadId?: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

/** One session-command argument, resolved to the session it names. */
interface ResolvedSessionArgument {
  sessionId: string;
  /** Canonical alias of the resolved session, when it has one. */
  alias?: string;
  /** How to name this target in a message: `alias 0905-1` or `session <id>`. */
  label: string;
}

/**
 * An argument that named more than one session.
 *
 * Distinguished from a failure on purpose: `/use DSH` matching two sessions is a
 * question, not an error, and it is answered with a picker card.
 */
interface AmbiguousSessionArgument {
  candidates: Array<{ sessionId: string; alias?: string; title?: string }>;
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
  /** Form fields the card submitted, for cards that collect input. */
  formValue?: Record<string, unknown>;
}

/** Explicit selector/confirmation workflow; no external activity can call bind. */
export class SessionProjectionController {
  private readonly pending = new Map<string, PendingBinding>();
  private readonly pendingDeletions = new Map<string, PendingDeletion>();
  private readonly pendingRenames = new Map<string, PendingRename>();
  private readonly pendingConnectionModes = new Map<string, PendingConnectionMode>();

  constructor(private readonly deps: {
    bridge: SessionProjectionBridge;
    store: SessionProjectionStore;
    sessions: SessionStore;
    scopes: ScopeDirectory;
    access: AccessManager;
    channel: CommandChannel;
    aliases?: SessionAliasManager;
    confirmationTtlMs?: number;
    /**
     * Scope → workspace registry and the run ledger, so a switch onto a session
     * that lives elsewhere can follow it the way `/cd` does. Optional because
     * embedded callers (the SDK/ACP adapters) may not mount a workspace layer;
     * `adoptWorkspace` then fails closed with the manual `/cd` instruction
     * rather than binding a chat to a workspace it cannot route to.
     */
    workspaces?: WorkspaceStore;
    activeRuns?: ActiveRuns;
  }) {}

  async handleAliasCommand(command: 'sessions' | 'use' | 'delete' | 'purge', args: string, ctx: CommandContext): Promise<void> {
    if (!this.deps.aliases) throw new Error('session aliases are not configured');
    const actorId = this.requireAuthorized(ctx.scope, ctx.chatId, ctx.chatMode, ctx.senderId);
    const alias = args.trim().split(/\s+/u).filter(Boolean)[0];
    if (command === 'use' && !alias) {
      // Bare `/use` opens the picker instead of printing a usage line: the alias
      // is the one thing the operator cannot read off the chat, and typing one
      // out of `/sessions` on a phone is the step worth removing.
      await this.sendSessionPicker({ actorId, ctx });
      return;
    }
    if (command !== 'sessions' && !alias) {
      throw new Error(`Usage: /${command} <MMDD-N>`);
    }
    if (command === 'sessions') {
      if (args.trim()) throw new Error('Usage: /sessions');
      // Read-only, so answering late only costs a re-sent list: run the work
      // behind an immediate reply instead of holding the command callback open.
      // The session listing route can take tens of seconds on a large history
      // (measured 53s on 2026-09-13), which is longer than the callback allows —
      // the operator saw "The operation was aborted due to timeout" for a list
      // that was in fact coming.
      await ctx.channel.sendMarkdown(
        ctx.chatId,
        bilingualMarkdown('正在读取会话列表…', 'Reading the session list…'),
        this.options(ctx.threadId),
      );
      void (async () => {
        const sessions = await this.deps.bridge.listSessions();
        await this.deps.aliases!.syncSessions(sessions.map((session) => ({
          sessionId: session.sessionId,
          updatedAt: session.updatedAt,
        })));
        const byId = new Map(sessions.map((session) => [session.sessionId, session]));
        const entries = this.deps.aliases!.entries().filter((entry) => byId.has(entry.sessionId));
        // Which session this chat is actually talking to. Two places can know:
        // the projection store, written only when /use confirms a switch, and the
        // run-flow's own session map, written whenever a turn runs — including
        // the very first message in a fresh chat, which mints a session without
        // anyone choosing it.
        //
        // Reading only the projection store is why a brand-new group showed no
        // current session: dsh had created one and the Web UI listed it, but
        // nothing had been *confirmed*, so /sessions marked nothing and told you
        // to bind — while the chat had in fact been using that session all along.
        // It only started reporting correctly after a /use, which is exactly the
        // symptom. The run-flow map is the broader truth, so it is the fallback.
        const boundCwd = ctx.workspaces.cwdFor(ctx.scope) ?? ctx.defaultWorkspace;
        const boundSessionId = this.deps.store.get(ctx.scope, boundCwd)?.sessionId
          ?? this.deps.sessions.resumeFor(ctx.scope, boundCwd);
        const connection = this.deps.store.get(ctx.scope, boundCwd);
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
            const modeLabel = connection?.sessionId === entry.sessionId
              ? ` · **${connection.connectionMode === 'full' ? '完整衔接' : '半衔接'}**`
              : ' · 未连接飞书';
            const here = entry.sessionId === boundSessionId
              ? ` ← **当前对话**${modeLabel}`
              : '';
            // A row from another workspace is now selectable — `/use` follows the
            // session — so say which workspace it belongs to instead of leaving
            // the operator to guess why its path differs.
            const elsewhere = session.cwd && session.cwd !== boundCwd ? ` · ⧉ \`${session.cwd}\`` : '';
            lines.push(`- \`${entry.alias}\` · **${title}** · ${status}${elsewhere}${here}`);
          }
          if (boundSessionId === undefined) {
            lines.push('', '当前对话还没有会话，发一条消息会自动新建一个，或用 `/use <别名>` 绑到已有的。');
          } else if (!entries.some((entry) => entry.sessionId === boundSessionId)) {
            // The chat is on a session the alias list does not cover — a
            // different workspace, or one already in the recycle bin. Saying so
            // beats silently marking nothing, which reads as "not bound".
            lines.push('', `当前对话的会话不在上面的列表里（\`${boundSessionId}\`），可能属于其它工作空间。`);
          }
        }
        await ctx.channel.sendMarkdown(
          ctx.chatId,
          lines.join('\n'),
          this.options(ctx.threadId),
        );
      })().catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await ctx.channel.sendMarkdown(
            ctx.chatId,
            bilingualMarkdown(`⚠️ 读取会话列表失败：${message}`, `⚠️ Could not read the session list: ${message}`),
            this.options(ctx.threadId),
          );
        } catch { /* the immediate reply already told the operator something is coming */ }
      });
      return;
    }
    const resolved = await this.resolveSessionArgument(command, alias!);
    if ('candidates' in resolved) {
      await this.sendCandidatePicker({
        argument: alias!,
        candidates: resolved.candidates,
        actorId,
        ctx,
      });
      return;
    }
    const target = resolved;
    const session = (await this.deps.bridge.listSessions())
      .find((item) => item.sessionId === target.sessionId);
    if (!session) {
      if (target.alias !== undefined) await this.deps.aliases.removeAlias(target.alias);
      throw new Error(`session for ${target.label} was already deleted`);
    }
    if (command === 'use' && session.trashed) {
      throw new Error(`${target.label} is in the recycle bin; restore it from the DSH Web session manager first`);
    }
    if (command === 'delete' && session.trashed) {
      throw new Error(`${target.label} is already in the recycle bin; use /purge ${target.label} for permanent deletion`);
    }
    const workspaceCwd = ctx.workspaces.cwdFor(ctx.scope) ?? ctx.defaultWorkspace;
    if (command === 'use') {
      // A session in another workspace is switchable, not an error: `/use` and
      // the picker card both list every workspace, so refusing here made rows
      // the bot had just offered un-tappable. Follow the session instead.
      const targetCwd = session.cwd && session.cwd !== workspaceCwd
        ? await this.adoptWorkspace({ scope: ctx.scope, currentCwd: workspaceCwd, targetCwd: session.cwd })
        : workspaceCwd;
      // Deliberately awaited: the ownership/admin checks inside must still reject
      // the command (an ordinary user may not migrate another scope's binding),
      // and a detached failure would surface as a chat line instead of an error.
      await this.prepareConfirmation({
        sessionId: target.sessionId,
        identity: { scope: ctx.scope, workspaceCwd: targetCwd, actorId },
        chatId: ctx.chatId,
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
      });
      return;
    }
    await this.prepareDeletion({
      alias: target.alias ?? target.sessionId,
      session,
      mode: command === 'purge' ? 'purge' : 'trash',
      actorId,
      scope: ctx.scope,
      workspaceCwd,
      chatId: ctx.chatId,
      ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    });
  }

  /**
   * Resolve a session command's argument to the session it names.
   *
   * `/use` accepts three forms, in order: an alias (what the bot prints), an
   * exact session id, and an unambiguous title — case-insensitively, where a
   * prefix is enough. A session created in the Web UI has no alias until
   * something has listed it, so someone reading a title off the Web UI had no
   * way to select that conversation from Feishu at all.
   *
   * `/delete` and `/purge` deliberately keep the alias-only contract: silently
   * targeting a near-identical sibling is survivable when it only changes which
   * conversation a chat follows, and is not when it permanently removes one.
   *
   * @param command - the session command whose argument is being resolved.
   * @param argument - the alias, session id or title prefix that was typed.
   * @returns the session to act on, plus how to name it back to the user.
   */
  private async resolveSessionArgument(
    command: 'use' | 'delete' | 'purge',
    argument: string,
  ): Promise<ResolvedSessionArgument | AmbiguousSessionArgument> {
    const aliases = this.deps.aliases;
    if (!aliases) throw new Error('session aliases are not configured');
    const fromAlias = aliases.getSessionId(argument);
    if (fromAlias) return this.describeTarget(fromAlias, aliases);
    if (command !== 'use') throw new Error(`alias not found: ${argument}`);
    const sessions = await this.deps.bridge.listSessions();
    const exact = sessions.find((session) => session.sessionId === argument);
    if (exact) return this.describeTarget(exact.sessionId, aliases);
    const needle = argument.toLowerCase();
    const matches = sessions.filter((session) => {
      const title = session.title?.trim().toLowerCase();
      return title !== undefined && title !== '' && title.startsWith(needle);
    });
    if (matches.length > 1) {
      // Not an error: several sessions legitimately share a prefix, and the
      // caller answers with a picker rather than a line to retype.
      const aliasBySessionId = new Map(aliases.entries().map((entry) => [entry.sessionId, entry.alias]));
      return {
        candidates: matches.map((session) => {
          const alias = aliasBySessionId.get(session.sessionId);
          const title = session.title?.trim();
          return {
            sessionId: session.sessionId,
            ...(alias === undefined ? {} : { alias }),
            ...(title === undefined || title === '' ? {} : { title }),
          };
        }),
      };
    }
    const [only] = matches;
    if (!only) throw new Error(`alias not found: ${argument}`);
    return this.describeTarget(only.sessionId, aliases);
  }

  /**
   * Offer every session in the workspace as a tappable row.
   *
   * This is what bare `/use` sends. The alias table is the only directory of
   * conversations the chat has, and reading an alias out of `/sessions` only to
   * type it into the next message is the step this removes.
   */
  private async sendSessionPicker(input: { actorId: string; ctx: CommandContext }): Promise<void> {
    const sessions = await this.deps.bridge.listSessions();
    const aliasBySessionId = new Map(
      (this.deps.aliases?.entries() ?? []).map((entry) => [entry.sessionId, entry.alias]),
    );
    const candidates = sessions.map((session) => {
      const alias = aliasBySessionId.get(session.sessionId);
      const title = session.title?.trim();
      return {
        sessionId: session.sessionId,
        ...(alias === undefined ? {} : { alias }),
        ...(title === undefined || title === '' ? {} : { title }),
      };
    });
    if (candidates.length === 0) {
      await this.deps.channel.sendMarkdown(
        input.ctx.chatId,
        bilingualMarkdown(
          '暂无可用会话。发一条消息会自动新建一个。',
          'No sessions available. Sending a message creates one.',
        ),
        this.options(input.ctx.threadId),
      );
      return;
    }
    await this.sendCandidatePicker({ candidates, actorId: input.actorId, ctx: input.ctx });
  }

  /**
   * Answer an ambiguous — or omitted — `/use` argument with one row per session.
   *
   * Falling back to a thrown line when the channel cannot render cards keeps the
   * command usable everywhere, and the message is bilingual either way.
   */
  private async sendCandidatePicker(input: {
    argument?: string;
    candidates: ReadonlyArray<{ sessionId: string; alias?: string; title?: string }>;
    actorId: string;
    ctx: CommandContext;
  }): Promise<void> {
    if (!this.deps.channel.sendCard) {
      const aliases = input.candidates
        .map((candidate) => candidate.alias ?? candidate.sessionId)
        .join('、');
      const what = input.argument === undefined ? '当前工作空间有' : `“${input.argument}”匹配到`;
      throw new Error(
        `${what} ${input.candidates.length} 个会话（${aliases}）；请改用其中一个别名，或直接给完整 session id。\n`
        + `${input.argument === undefined ? 'This workspace has' : `"${input.argument}" matches`} ${input.candidates.length} sessions (${aliases}); use one of those aliases or a full session id.`,
      );
    }
    const identity = {
      scope: input.ctx.scope,
      workspaceCwd: input.ctx.workspaces.cwdFor(input.ctx.scope) ?? input.ctx.defaultWorkspace,
      actorId: input.actorId,
    };
    await this.deps.channel.sendCard(
      input.ctx.chatId,
      renderSessionCandidateCard({
        ...(input.argument === undefined ? {} : { argument: input.argument }),
        candidates: input.candidates,
        scope: identity.scope,
        workspaceCwd: identity.workspaceCwd,
        actorId: identity.actorId,
      }),
      this.options(input.ctx.threadId),
    );
  }

  /** Name a resolved session the way this file's messages do. */
  private describeTarget(sessionId: string, aliases: SessionAliasManager): ResolvedSessionArgument {
    const alias = aliases.entries().find((entry) => entry.sessionId === sessionId)?.alias;
    return alias === undefined
      ? { sessionId, label: `session ${sessionId}` }
      : { sessionId, alias, label: `alias ${alias}` };
  }

  /**
   * `/rename <MMDD-N> [name]` — with a name, set it; without one, open the
   * card so the name can be typed without retyping the alias.
   */
  async handleRenameCommand(args: string, ctx: CommandContext): Promise<void> {
    if (!this.deps.aliases) throw new Error('session aliases are not configured');
    const actorId = this.requireAuthorized(ctx.scope, ctx.chatId, ctx.chatMode, ctx.senderId);
    const trimmed = args.trim();
    const [alias, ...rest] = trimmed.split(/\s+/u).filter(Boolean);
    if (!alias) throw new Error('Usage: /rename <MMDD-N> [新名称]');
    const sessionId = this.deps.aliases.getSessionId(alias);
    if (!sessionId) throw new Error(`alias not found: ${alias}`);
    const session = (await this.deps.bridge.listSessions()).find((item) => item.sessionId === sessionId);
    if (!session) {
      await this.deps.aliases.removeAlias(alias);
      throw new Error(`session for alias ${alias} was already deleted`);
    }
    const workspaceCwd = ctx.workspaces.cwdFor(ctx.scope) ?? ctx.defaultWorkspace;
    const requested = rest.join(' ').trim();
    if (requested !== '') {
      const accepted = await this.deps.bridge.renameSession(sessionId, requested);
      await ctx.channel.sendMarkdown(ctx.chatId, bilingualMarkdown(
        `✏️ 已重命名 \`${alias}\` 为 **${accepted}**，网页端同步显示。`,
        `✏️ Renamed \`${alias}\` to **${accepted}**; the Web UI shows it too.`,
      ), this.options(ctx.threadId));
      return;
    }
    await this.offerName({
      alias,
      sessionId,
      ...(session.title === undefined ? {} : { currentTitle: session.title }),
      actorId,
      scope: ctx.scope,
      workspaceCwd,
      chatId: ctx.chatId,
      ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    });
  }

  /**
   * Send the name card for one session and remember what it may rename.
   *
   * The card carries only a nonce; the alias, session, actor and scope it is
   * allowed to touch are held here, so a card cannot be replayed against a
   * different session or by a different person.
   */
  async offerName(input: {
    alias: string;
    sessionId: string;
    currentTitle?: string;
    actorId: string;
    scope: string;
    workspaceCwd: string;
    chatId: string;
    threadId?: string;
    fresh?: boolean;
  }): Promise<void> {
    if (!this.deps.channel.sendCard) throw new Error('当前渠道不支持命名卡片');
    const nonce = randomUUID();
    const expiresAt = Date.now() + (this.deps.confirmationTtlMs ?? 10 * 60_000);
    const timer = setTimeout(() => this.pendingRenames.delete(nonce), expiresAt - Date.now());
    timer.unref?.();
    this.pendingRenames.set(nonce, {
      nonce,
      alias: input.alias,
      sessionId: input.sessionId,
      actorId: input.actorId,
      scope: input.scope,
      workspaceCwd: input.workspaceCwd,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      expiresAt,
      timer,
    });
    await this.deps.channel.sendCard(input.chatId, renderSessionNameCard({
      alias: input.alias,
      sessionId: input.sessionId,
      ...(input.currentTitle === undefined ? {} : { currentTitle: input.currentTitle }),
      nonce,
      scope: input.scope,
      workspaceCwd: input.workspaceCwd,
      actorId: input.actorId,
      ...(input.fresh ? { fresh: true } : {}),
    }), this.options(input.threadId));
  }

  private async handleRenameAction(input: SessionProjectionActionInput): Promise<SessionProjectionActionResult> {
    this.pruneExpired();
    const requestedScope = typeof input.value.scope === 'string' ? input.value.scope : '';
    const cardActor = typeof input.value.actorId === 'string' ? input.value.actorId : '';
    if (!input.operatorId || input.operatorId !== cardActor || requestedScope !== input.currentScope) {
      return { toast: { type: 'error', content: '身份或 scope 不匹配 / Operator or scope mismatch' } };
    }
    const entry = this.deps.scopes.entry(requestedScope);
    const mode = entry?.chatMode ?? (input.threadId ? 'topic' : 'group');
    try {
      this.requireAuthorized(requestedScope, input.chatId, mode, input.operatorId);
      const nonce = typeof input.value.nonce === 'string' ? input.value.nonce : '';
      const pending = this.pendingRenames.get(nonce);
      if (!pending || pending.expiresAt <= Date.now() || pending.actorId !== input.operatorId ||
          pending.scope !== requestedScope || pending.chatId !== input.chatId ||
          pending.threadId !== input.threadId) {
        if (pending) clearTimeout(pending.timer);
        this.pendingRenames.delete(nonce);
        throw new Error('naming card expired or no longer matches its original target');
      }
      clearTimeout(pending.timer);
      this.pendingRenames.delete(nonce);
      const title = typeof input.formValue?.title === 'string' ? input.formValue.title.trim() : '';
      // An empty submit is a real answer: keep whatever dsh named it.
      if (title === '') {
        return {
          toast: { type: 'info', content: '已保留 DSH 默认命名 / Kept dsh’s own naming' },
          settle: bilingualMarkdown(
            `保留 DSH 默认命名，未修改 \`${pending.alias}\`。`,
            `Kept dsh’s own naming; \`${pending.alias}\` is unchanged.`,
          ),
        };
      }
      const accepted = await this.deps.bridge.renameSession(pending.sessionId, title);
      return {
        toast: { type: 'success', content: `Renamed ${pending.alias}` },
        settle: bilingualMarkdown(
          `✏️ \`${pending.alias}\` 已命名为 **${accepted}**，网页端同步显示。`,
          `✏️ \`${pending.alias}\` is now **${accepted}**; the Web UI shows it too.`,
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toast: { type: 'error', content: message },
        settle: bilingualMarkdown(`⚠️ 命名失败：${message}`, `⚠️ Naming failed: ${message}`),
      };
    }
  }

  async createNewSession(ctx: CommandContext, workspaceCwd: string): Promise<string> {
    if (!this.deps.aliases) throw new Error('session aliases are not configured');
    const sessionId = await this.deps.bridge.createSession(workspaceCwd);
    const alias = await this.deps.aliases.registerSession(sessionId);
    await this.attachSession({
      scope: ctx.scope,
      workspaceCwd,
      chatId: ctx.chatId,
      ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
      sessionId,
      connectionMode: 'half',
    });
    return alias;
  }

  async connectFeishuTurn(input: {
    scope: string;
    workspaceCwd: string;
    chatId: string;
    threadId?: string;
    sessionId: string;
    rpcId: string;
    feishuMessageId: string;
  }): Promise<void> {
    let binding = this.deps.store.get(input.scope, input.workspaceCwd);
    if (!binding || binding.sessionId !== input.sessionId) {
      binding = await this.attachSession({ ...input, connectionMode: 'half' });
    }
    await this.deps.store.recordCorrelation(
      input.scope,
      input.workspaceCwd,
      input.sessionId,
      { rpcId: input.rpcId, feishuMessageId: input.feishuMessageId, createdAt: Date.now() },
    );
  }

  async handleConnectionCommand(command: 'switch' | 'detach', args: string, ctx: CommandContext): Promise<void> {
    if (args.trim()) throw new Error(`Usage: /${command}`);
    const actorId = this.requireAuthorized(ctx.scope, ctx.chatId, ctx.chatMode, ctx.senderId);
    const workspaceCwd = ctx.workspaces.cwdFor(ctx.scope) ?? ctx.defaultWorkspace;
    const binding = this.deps.store.get(ctx.scope, workspaceCwd);
    if (command === 'detach') {
      if (!binding) {
        await ctx.channel.sendMarkdown(
          ctx.chatId,
          bilingualMarkdown('当前聊天没有连接飞书会话。', 'This chat has no attached DSH session.'),
          this.options(ctx.threadId),
        );
        return;
      }
      await this.deps.store.remove(ctx.scope, workspaceCwd);
      this.deps.sessions.clearSession(ctx.scope, workspaceCwd);
      await ctx.channel.sendMarkdown(
        ctx.chatId,
        bilingualMarkdown(
          `🔌 已断开飞书连接；DSH session \`${binding.sessionId}\` 仍保留。下一条普通消息会创建新的独立会话。`,
          `🔌 Detached from Feishu; DSH session \`${binding.sessionId}\` remains. The next ordinary message creates a new independent session.`,
        ),
        this.options(ctx.threadId),
      );
      return;
    }
    if (!binding) throw new Error('当前聊天还没有连接会话；先发一条普通消息或使用 /use <别名>');
    if (!this.deps.channel.sendCard) throw new Error('当前渠道不支持模式切换卡片');
    const nonce = randomUUID();
    const expiresAt = Date.now() + (this.deps.confirmationTtlMs ?? 10 * 60_000);
    const timer = setTimeout(() => this.pendingConnectionModes.delete(nonce), expiresAt - Date.now());
    timer.unref?.();
    this.pendingConnectionModes.set(nonce, {
      nonce,
      actorId,
      scope: ctx.scope,
      workspaceCwd,
      sessionId: binding.sessionId,
      chatId: ctx.chatId,
      ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
      expiresAt,
      timer,
    });
    await this.deps.channel.sendCard(ctx.chatId, renderSessionConnectionModeCard({
      nonce,
      identity: { scope: ctx.scope, workspaceCwd, actorId },
      sessionId: binding.sessionId,
      currentMode: binding.connectionMode,
    }), this.options(ctx.threadId));
  }

  async handleAction(input: SessionProjectionActionInput): Promise<SessionProjectionActionResult> {
    if (input.value.cmd === 'session-alias') return this.handleAliasAction(input);
    if (input.value.cmd === 'session-rename') return this.handleRenameAction(input);
    if (input.value.cmd === 'session-connection') return this.handleConnectionAction(input);
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
        connectionMode: 'half',
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
    for (const pending of this.pendingRenames.values()) clearTimeout(pending.timer);
    this.pendingRenames.clear();
    for (const pending of this.pendingConnectionModes.values()) clearTimeout(pending.timer);
    this.pendingConnectionModes.clear();
  }

  private async handleConnectionAction(input: SessionProjectionActionInput): Promise<SessionProjectionActionResult> {
    this.pruneExpired();
    const requestedScope = typeof input.value.scope === 'string' ? input.value.scope : '';
    const workspaceCwd = typeof input.value.workspaceCwd === 'string' ? input.value.workspaceCwd : '';
    const cardActor = typeof input.value.actorId === 'string' ? input.value.actorId : '';
    if (!input.operatorId || input.operatorId !== cardActor || requestedScope !== input.currentScope) {
      return { toast: { type: 'error', content: '身份或 scope 不匹配 / Operator or scope mismatch' } };
    }
    const entry = this.deps.scopes.entry(requestedScope);
    const chatMode = entry?.chatMode ?? (input.threadId ? 'topic' : 'group');
    try {
      this.requireAuthorized(requestedScope, input.chatId, chatMode, input.operatorId);
      const nonce = typeof input.value.nonce === 'string' ? input.value.nonce : '';
      const pending = this.pendingConnectionModes.get(nonce);
      if (!pending || pending.expiresAt <= Date.now() || pending.actorId !== input.operatorId ||
          pending.scope !== requestedScope || pending.workspaceCwd !== workspaceCwd ||
          pending.chatId !== input.chatId || pending.threadId !== input.threadId) {
        if (pending) clearTimeout(pending.timer);
        this.pendingConnectionModes.delete(nonce);
        throw new Error('mode card expired or no longer matches its original session');
      }
      const mode = input.value.action === 'full' ? 'full' : input.value.action === 'half' ? 'half' : undefined;
      if (!mode) throw new Error('unknown connection mode');
      clearTimeout(pending.timer);
      this.pendingConnectionModes.delete(nonce);
      const current = this.deps.store.get(pending.scope, pending.workspaceCwd);
      if (!current || current.sessionId !== pending.sessionId) {
        throw new Error('session attachment changed; send /switch again');
      }
      await this.deps.store.setConnectionMode(pending.scope, pending.workspaceCwd, mode);
      const zhMode = mode === 'full' ? '完整衔接' : '半衔接';
      const enMode = mode === 'full' ? 'Full connection' : 'Half connection';
      return {
        toast: { type: 'success', content: `已切换为${zhMode} / ${enMode}` },
        settle: bilingualMarkdown(
          `✅ 已切换为 **${zhMode}**。`,
          `✅ Switched to **${enMode}**.`,
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toast: { type: 'error', content: message },
        settle: bilingualMarkdown(`⚠️ 模式切换失败：${message}`, `⚠️ Mode switch failed: ${message}`),
      };
    }
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
      if (action === 'use-cancel') {
        return {
          toast: { type: 'info', content: '已取消 / Cancelled' },
          settle: bilingualMarkdown('已取消，绑定未改变。', 'Cancelled; the binding is unchanged.'),
        };
      }
      if (action === 'use-pick') {
        // A pick from the ambiguity card only opens the ordinary confirmation;
        // the binding still needs the nonce-protected `/use` confirm, so a
        // mis-tap cannot rebind the chat by itself.
        const picked = typeof input.value.sessionId === 'string' ? input.value.sessionId : '';
        if (!picked) throw new Error('the picked candidate carries no session id');
        const pickedLabel = typeof input.value.label === 'string' && input.value.label !== ''
          ? input.value.label
          : picked;
        // The confirmation resumes the session and reads its log, which can
        // outlast the card callback's deadline — answering the callback that
        // late shows the operator 目标回调服务超时未响应 for work that in fact
        // succeeded. So the picker settles now and the confirmation card is
        // opened behind it, with a failure reported into the chat rather than
        // into a callback nobody is listening to any more.
        void (async () => {
          // The picker lists every workspace, so a pick may name a session the
          // chat is not currently in; follow it before preparing (see
          // adoptWorkspace) instead of failing the tap that the bot invited.
          const pickedSession = (await this.deps.bridge.listSessions())
            .find((item) => item.sessionId === picked);
          if (!pickedSession) throw new Error(`session ${picked} was already deleted`);
          if (pickedSession.trashed) {
            throw new Error(`${pickedLabel} is in the recycle bin; restore it from the DSH Web session manager first`);
          }
          const targetCwd = pickedSession.cwd && pickedSession.cwd !== workspaceCwd
            ? await this.adoptWorkspace({ scope: requestedScope, currentCwd: workspaceCwd, targetCwd: pickedSession.cwd })
            : workspaceCwd;
          await this.prepareConfirmation({
            sessionId: picked,
            identity: { scope: requestedScope, workspaceCwd: targetCwd, actorId: cardActor },
            chatId: input.chatId,
            ...(input.threadId ? { threadId: input.threadId } : {}),
          });
        })().catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          try {
            await this.deps.channel.sendMarkdown(
              input.chatId,
              bilingualMarkdown(
                `⚠️ 打开确认卡失败：${message}`,
                `⚠️ Could not open the confirmation card: ${message}`,
              ),
              this.options(input.threadId),
            );
          } catch { /* the chat already saw the failure as a toast */ }
        });
        return {
          toast: { type: 'success', content: `已选择 ${pickedLabel} / Selected ${pickedLabel}` },
          settle: bilingualMarkdown(
            `✅ 已选择 \`${pickedLabel}\`，确认卡随后弹出。`,
            `✅ Selected \`${pickedLabel}\`; the confirmation card follows.`,
          ),
        };
      }
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

  private async attachSession(input: {
    scope: string;
    workspaceCwd: string;
    chatId: string;
    threadId?: string;
    sessionId: string;
    connectionMode: FeishuConnectionMode;
  }) {
    const current = this.deps.store.get(input.scope, input.workspaceCwd);
    if (current?.sessionId === input.sessionId) return current;
    const owner = this.deps.store.ownerOf(input.sessionId);
    if (owner && (owner.scope !== input.scope || owner.workspaceCwd !== input.workspaceCwd)) {
      throw new Error('该 session 已连接到另一个飞书聊天；请先在原聊天 /detach，或由管理员使用 /use 迁移');
    }
    const prepared = await this.deps.bridge.prepare(input.sessionId, input.workspaceCwd);
    const result = await this.deps.bridge.bindConfirmed({
      scope: input.scope,
      workspaceCwd: input.workspaceCwd,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      prepared,
      deliverHistory: false,
      connectionMode: input.connectionMode,
      ...(owner ? { expectedOwner: { scope: owner.scope, workspaceCwd: owner.workspaceCwd } } : {}),
      onBindingCommitted: () => {
        this.deps.sessions.clearSessionElsewhere(input.sessionId, input.scope, input.workspaceCwd);
        this.deps.sessions.set(input.scope, input.sessionId, input.workspaceCwd);
      },
    });
    return result.binding;
  }


  /**
   * Move this chat into the workspace a target session lives in.
   *
   * Both `/use` and the picker card offer sessions from every workspace, while
   * binding is stored per `(scope, workspaceCwd)`. Nothing requires the two to
   * match, so a target elsewhere is reachable — it just needs the chat's
   * workspace to follow it first, which is exactly what `/cd` does. Doing it
   * silently (rather than asking for a second command) keeps a tap on a listed
   * session working, and the confirmation card still shows the resulting
   * workspace before anything is committed.
   *
   * @returns the workspace the binding must be created under.
   */
  private async adoptWorkspace(input: {
    scope: string;
    currentCwd: string;
    targetCwd: string;
  }): Promise<string> {
    if (!input.targetCwd || input.targetCwd === input.currentCwd) return input.currentCwd;
    if (!this.deps.workspaces) {
      throw new Error(
        `该会话属于工作空间 ${input.targetCwd}，当前适配器不支持自动切换；请先发 /cd ${input.targetCwd} 再重试。\n`
        + `This session belongs to workspace ${input.targetCwd} and this adapter cannot switch automatically; send /cd ${input.targetCwd} first.`,
      );
    }
    // Same contract as `/cd`: leaving a workspace stops what is still running in
    // it, so a turn cannot keep writing into a workspace the chat has left.
    if (this.deps.activeRuns) {
      await this.deps.activeRuns.interruptWorkspace(input.scope, input.currentCwd);
    }
    this.deps.workspaces.setCwd(input.scope, input.targetCwd);
    return input.targetCwd;
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
    for (const [nonce, pending] of this.pendingRenames) {
      if (pending.expiresAt <= now) {
        clearTimeout(pending.timer);
        this.pendingRenames.delete(nonce);
      }
    }
    for (const [nonce, pending] of this.pendingConnectionModes) {
      if (pending.expiresAt <= now) {
        clearTimeout(pending.timer);
        this.pendingConnectionModes.delete(nonce);
      }
    }
  }

  private options(threadId: string | undefined): { threadId: string } | undefined {
    return threadId ? { threadId } : undefined;
  }
}
