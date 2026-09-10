import type { Context } from '@deepseek-ai/cordis';
import {
  objectArgs,
  requiredString,
  type RawToolExecution,
  type ToolPluginContext,
} from './raw-tool.js';

export const name = 'lark-plan-approval';
export const inject = ['tools'];

export interface Config {
  endpoint?: string;
  token?: string;
}

/** Optional user-decision card; it never intercepts or denies tool execution. */
export function apply(ctx: Context, config: Config = {}) {
  (ctx as ToolPluginContext).tools.register({
    name: 'lark_request_plan_approval',
    description:
      'Ask the user to choose or approve a genuinely ambiguous execution plan in Feishu/Lark. Use only when the task has materially different options or the user explicitly requested a plan decision; ordinary tool calls use DSH native approval and must not be blocked by this tool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['plan'],
      properties: {
        plan: { type: 'string', minLength: 1, description: 'Complete readable plan in Markdown.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['resolved'],
        properties: {
          resolved: { type: 'boolean' },
          decision: { type: 'string', enum: ['approved', 'revise'] },
          feedback: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, rawValue) => {
        const value = rawValue as {
          resolved: boolean;
          decision?: string;
          feedback?: string;
          error?: string;
        };
        return [{
          type: 'text',
          text: value.resolved
            ? `Plan decision: ${value.decision}${value.feedback ? `; feedback: ${value.feedback}` : ''}`
            : `Plan approval failed: ${value.error ?? 'cancelled'}`,
        }];
      },
    },
    async execute(rawArgs, exec: RawToolExecution | undefined) {
      const args = objectArgs(rawArgs, 'lark_request_plan_approval');
      const plan = requiredString(args, 'plan', 'lark_request_plan_approval');
      const endpoint = config.endpoint ?? process.env.DSH_LARK_PLAN_URL;
      const token = config.token ?? process.env.DSH_LARK_NOTIFY_TOKEN;
      if (!endpoint || !token) {
        throw new Error('lark_request_plan_approval is not configured (endpoint/token missing)');
      }
      const sessionId = exec?.agent?.session === undefined
        ? undefined
        : String(exec.agent.session.id);
      if (!sessionId) throw new Error('lark_request_plan_approval needs an active session');
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, sessionId, plan }),
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
        });
      } catch (error) {
        if (exec?.signal?.aborted) return { resolved: false, error: 'cancelled' };
        throw error;
      }
      const body = await response.json() as {
        ok?: boolean;
        decision?: 'approved' | 'revise';
        feedback?: string;
        error?: string;
      };
      if (!response.ok || body.ok !== true || !body.decision) {
        if (body.error?.toLowerCase().includes('cancel')) {
          return { resolved: false, error: body.error };
        }
        throw new Error(body.error ?? `plan approval delivery failed (${response.status})`);
      }
      return {
        resolved: true,
        decision: body.decision,
        ...(body.feedback ? { feedback: body.feedback } : {}),
      };
    },
  });
}
