export type PolicyLayer =
  | 'dsh-native-approval'
  | 'file-sandbox'
  | 'plan-gate';

export interface PolicyDenial {
  layer: PolicyLayer;
  reason: string;
  toChange: string;
}

export function policyDenialText(denial: PolicyDenial): string {
  return `[policy-denial layer=${denial.layer}] denied by ${denial.layer}: ${denial.reason}\n` +
    `to change: ${denial.toChange}`;
}

export function toolApprovalDenial(toolName: string): PolicyDenial {
  return {
    layer: 'dsh-native-approval',
    reason: `the user rejected DSH's native approval for tool ${toolName}`,
    toChange: 'choose a safer alternative or request the DSH approval again',
  };
}

export function renderToolPolicyPersona(): string[] {
  return [
    'The Feishu bridge does not add a tool gate. Use tools normally; only DSH native approval and sandbox policy may block execution.',
    'Use lark_request_plan_approval only for a genuine user decision between materially different plans, never as a prerequisite for ordinary tool calls.',
  ];
}
