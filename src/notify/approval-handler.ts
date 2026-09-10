import { randomUUID } from 'node:crypto';
import type { ApprovalOutcome, ApprovalRequest } from '../adapters/types.js';
import type { ApprovalRegistry } from '../bot/approvals.js';
import type { ScopeDirectory } from '../bridge/scope-directory.js';
import type { SendOptions } from '../bridge/send-options.js';
import { renderApprovalCard } from '../card/approval-card.js';
import { bilingualMarkdown } from '../card/i18n.js';
import { log } from '../core/logger.js';
import type { SessionStore } from '../session/store.js';
import type { CanRouteSessionToFeishu } from './can-route.js';
import {
  toolApprovalDenial,
  type PolicyDenial,
} from '../policy/tool-policy.js';

export interface ApprovalPayload {
  token: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  toolInput?: unknown;
  /** Deprecated; retained for wire compatibility and ignored. */
  policyCheckOnly?: boolean;
  /** Deprecated; retained for wire compatibility and ignored. */
  lowRisk?: boolean;
}

export interface ApprovalResult {
  ok: boolean;
  outcome?: ApprovalOutcome;
  error?: string;
  denial?: PolicyDenial;
  /**
   * The engine took ownership of this request: a Feishu card was delivered and
   * the request's answer belongs to Feishu. The answerer must then NOT also ask
   * the desktop, because a prompt the native answerer already surfaced cannot
   * be recalled.
   *
   * Absent — never `false` — when no card was delivered. That absence is the
   * single "desktop owns it" signal the answerer acts on.
   */
  owned?: boolean;
  /** Deprecated; this bridge no longer applies its own permission policy. */
  policy?: 'ask' | 'allow' | 'deny';
}

export interface ApprovalHandlerDeps {
  sessions: SessionStore;
  canRouteSessionToFeishu?: CanRouteSessionToFeishu;
  scopeDirectory: ScopeDirectory;
  approvals: ApprovalRegistry;
  onApprovalWaiting?: (scope: string, toolName: string) => () => void;
  channel: {
    sendCard(chatId: string, card: object, options?: SendOptions): Promise<string | undefined>;
    sendMarkdown?(chatId: string, markdown: string, options?: SendOptions): Promise<void>;
    recallMessage?(messageId: string): Promise<void>;
  };
}

export function buildApprovalHandler(
  deps: ApprovalHandlerDeps,
): (payload: ApprovalPayload, signal?: AbortSignal) => Promise<ApprovalResult> {
  return async (payload, signal) => {
    const canRoute = deps.canRouteSessionToFeishu;
    if (canRoute !== undefined && (await canRoute(payload.sessionId)) === false) {
      return { ok: false, error: `session is not currently connected to Feishu: ${payload.sessionId}` };
    }
    const scope = deps.sessions.scopeForSession(payload.sessionId);
    if (!scope) return { ok: false, error: `unknown session: ${payload.sessionId}` };
    const destination = deps.scopeDirectory.resolve(scope);
    if (!destination) return { ok: false, error: `unknown scope: ${scope}` };
    const id = `approval-${randomUUID().replaceAll('-', '')}`;
    const request: ApprovalRequest = {
      id,
      ...(payload.callId === undefined ? {} : { callId: payload.callId }),
      sessionId: payload.sessionId,
      toolName: payload.toolName,
      reason: payload.reason,
      toolInput: payload.toolInput ?? (payload.callId
        ? deps.approvals.toolInput(payload.sessionId, payload.callId)
        : undefined),
      options: [
        { optionId: 'allow-once', name: '允许执行一次', kind: 'allow_once' },
        { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
      ],
    };
    if (signal?.aborted) return { ok: false, error: 'approval cancelled' };
    const promise = deps.approvals.register(scope, request, payload.sessionId);
    let cardMessageId: string | undefined;
    /** Whether the chat already holds this request's card (the ownership line). */
    let delivered = false;
    const cancel = (): void => { deps.approvals.cancel(scope, id); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      if (signal?.aborted) return { ok: false, error: 'approval cancelled' };
      const options = destination.threadId && destination.messageId
        ? { threadId: destination.threadId, replyTo: destination.messageId }
        : undefined;
      cardMessageId = await deps.channel.sendCard(
        destination.chatId,
        renderApprovalCard({
          ...request,
          actionScope: scope,
          englishOptionNames: {
            'allow-once': 'Allow once',
            'reject-once': 'Reject',
          },
        }),
        options,
      );
      // From here the chat has a live card: Feishu owns this request, and every
      // result must say so. A cancelled answer still reports the ownership, so
      // the mirror never hands a request whose card is gone to the desktop.
      delivered = true;
      const cancelReminder = deps.onApprovalWaiting?.(scope, payload.toolName);
      let outcome: ApprovalOutcome;
      try {
        outcome = await promise;
      } finally {
        cancelReminder?.();
      }
      if (outcome === 'cancelled') {
        await settleCancelledCard(deps, destination.chatId, cardMessageId, options);
        return { ok: true, owned: true, outcome: 'cancelled' };
      }
      return {
        ok: true,
        owned: true,
        outcome,
        ...(outcome === 'rejected'
          ? { denial: toolApprovalDenial(payload.toolName) }
          : {}),
      };
    } catch (error) {
      log.fail('approval-card', error, { scope, sessionId: payload.sessionId });
      cancel();
      return {
        ok: false,
        ...(delivered ? { owned: true } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
}

async function settleCancelledCard(
  deps: ApprovalHandlerDeps,
  chatId: string,
  messageId: string | undefined,
  options: SendOptions | undefined,
): Promise<void> {
  try {
    await deps.channel.sendMarkdown?.(
      chatId,
      bilingualMarkdown(
        '⏹ **操作审批已取消** — 原任务已结束或断开',
        '⏹ **Operation approval cancelled** — the original task finished or disconnected',
      ),
      options,
    );
  } catch (error) {
    log.warn('approval-card', 'cancel-confirm-failed', { error });
  }
  if (!messageId || !deps.channel.recallMessage) return;
  try {
    await deps.channel.recallMessage(messageId);
  } catch (error) {
    log.warn('approval-card', 'cancel-recall-failed', { error });
  }
}
