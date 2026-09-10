import type { Context } from '@deepseek-ai/cordis';
import { log } from '../core/logger.js';
import {
  type PolicyDenial,
} from '../policy/tool-policy.js';

export const name = 'lark-approval-answerer';
export const inject = ['approval', 'tools'];

export interface Config {
  endpoint?: string;
  token?: string;
}

type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * What the engine decided about one request.
 *
 * `owned: true` means the engine accepted the request *and* delivered a Feishu
 * card, so its `outcome` is the only answer that exists for it. `owned: false`
 * means no card is out and the desktop answerer still owns the request.
 */
type OwnershipDecision =
  | { owned: true; outcome: Outcome; denial?: PolicyDenial }
  | { owned: false };

interface RawApprovalRequest {
  agent?: { session?: { id?: unknown } };
  toolName?: unknown;
  callId?: unknown;
  reason?: unknown;
  toolInput?: unknown;
  signal?: AbortSignal;
  lowRisk?: boolean;
}

type ApprovalContext = Context & {
  on(
    event: 'approval/request',
    listener: (request: RawApprovalRequest, next: () => Promise<Outcome>) => Promise<Outcome>,
  ): unknown;
};

/**
 * Mirror only approvals that DSH itself decided to ask.
 *
 * Every request has exactly one owner, and this listener decides which one
 * before anything is surfaced. It asks Feishu first and only falls back to
 * `next()` — the DSH-native desktop/Web answerer — when the engine did not take
 * the request at all.
 *
 * Asking both is not an option: once `next()` has put a prompt in the browser,
 * DSH exposes no way to recall it, so a card answered first would leave a tool
 * call that Feishu already settled still waiting on screen. That is the defect
 * this rule removes (session `session-07e35a7b`, where the Feishu-approved
 * `write` request kept its browser prompt forever). The mirror-image bug is
 * gone with it: a Feishu `rejected` no longer re-asks the desktop.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const approvalCtx = ctx as ApprovalContext;

  approvalCtx.on('approval/request', async (request, next) => {
    if (request.signal?.aborted) {
      // DSH already withdrew this request, so there is nothing left to ask.
      // Running the native answerer for a dead request can only produce a
      // prompt no answer can close.
      return 'cancelled';
    }
    const decision = await requestBridgeApproval(config, request);
    const sessionId = typeof request.agent?.session?.id === 'string'
      ? request.agent.session.id
      : undefined;
    const toolName = typeof request.toolName === 'string' ? request.toolName : undefined;
    if (!decision.owned) {
      log.info('approval-answerer', 'desktop-owns-request', {
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(toolName === undefined ? {} : { toolName }),
      });
      return next();
    }
    log.info('approval-answerer', 'feishu-owns-request', {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(toolName === undefined ? {} : { toolName }),
      outcome: decision.outcome,
    });
    return decision.outcome;
  });
}

/**
 * Ask the bridge whether it owns this request.
 *
 * `owned` is read from the response body regardless of the HTTP status: it is
 * the engine's own statement that it holds the request, and it outranks the
 * transport's verdict. Anything without it — a missing endpoint or token, a
 * session the engine cannot route to Feishu, an unreachable engine — leaves the
 * request to the desktop, which is where it would have gone had this plugin
 * never been installed.
 */
async function requestBridgeApproval(
  config: Config,
  request: RawApprovalRequest,
): Promise<OwnershipDecision> {
    const endpoint = approvalEndpoint(config);
    const token = config.token ?? process.env.DSH_LARK_NOTIFY_TOKEN;
    if (!endpoint || !token) return { owned: false };
    const sessionId = request.agent?.session?.id;
    if (sessionId === undefined || typeof request.toolName !== 'string') {
      return { owned: false };
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          sessionId: String(sessionId),
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
          ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
          ...(request.toolInput === undefined ? {} : { toolInput: request.toolInput }),
          ...('lowRisk' in request && request.lowRisk === true ? { lowRisk: true } : {}),
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const body = await response.json() as {
        ok?: unknown;
        owned?: unknown;
        outcome?: unknown;
        denial?: unknown;
      };
      if (body.owned !== true) return { owned: false };
      return response.ok && body.ok === true && isOutcome(body.outcome)
        ? {
            owned: true,
            outcome: body.outcome,
            ...(isPolicyDenial(body.denial) ? { denial: body.denial } : {}),
          }
        // A card was delivered and the engine closed the request without a
        // decision it could state. Reporting it as cancelled keeps the request
        // with Feishu; handing it to the desktop here would surface a prompt
        // for a request whose card is already gone.
        : { owned: true, outcome: 'cancelled' };
    } catch {
      // An abort is attributable to the request itself: DSH withdrew it, so no
      // answerer has anything left to answer. Every other failure is the engine
      // being unreachable, which leaves the desktop as the only owner.
      return request.signal?.aborted === true
        ? { owned: true, outcome: 'cancelled' }
        : { owned: false };
    }
}

function approvalEndpoint(config: Config): string | undefined {
  return config.endpoint ?? process.env.DSH_LARK_APPROVAL_URL;
}

function isOutcome(value: unknown): value is Outcome {
  return value === 'allowed-once' || value === 'rejected' ||
    value === 'cancelled' || value === 'unavailable';
}

function isPolicyDenial(value: unknown): value is PolicyDenial {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const denial = value as Partial<PolicyDenial>;
  return (
    denial.layer === 'dsh-native-approval' || denial.layer === 'plan-gate' ||
    denial.layer === 'file-sandbox'
  ) && typeof denial.reason === 'string' && typeof denial.toChange === 'string';
}
