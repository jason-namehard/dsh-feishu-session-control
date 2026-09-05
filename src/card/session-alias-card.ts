import type { DshSessionSummary } from '../session/projection-protocol.js';
import { redactSecrets, truncateUtf8Safe } from '../config/security.js';
import { localizedCard, type CardLocale } from './i18n.js';

export function renderSessionDeleteConfirmCard(input: {
  alias: string;
  session: DshSessionSummary;
  nonce: string;
  scope: string;
  workspaceCwd: string;
  actorId: string;
}): object {
  const body = (locale: CardLocale) => {
    const zh = locale === 'zh_cn';
    const title = input.session.title?.trim() || (zh ? '未命名会话' : 'Untitled session');
    const status = input.session.running
      ? (zh ? '运行中' : 'Running')
      : (zh ? '已停止' : 'Idle');
    const value = {
      cmd: 'session-alias',
      alias: input.alias,
      nonce: input.nonce,
      scope: input.scope,
      workspaceCwd: input.workspaceCwd,
      actorId: input.actorId,
    };
    return {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${zh ? '确认删除会话' : 'Confirm session deletion'}**`,
            '',
            `${zh ? '别名' : 'Alias'}: **\`${safe(input.alias, 128)}\`**`,
            `${zh ? '名称' : 'Name'}: ${safe(title, 256)}`,
            `${zh ? '状态' : 'Status'}: ${status}`,
            `${zh ? '真实会话 ID' : 'Native session ID'}: \`${safe(input.session.sessionId, 256)}\``,
            '',
            input.session.running
              ? (zh
                ? '⚠️ 该会话正在运行。删除会先停止任务，并永久移除会话记录，无法恢复。'
                : '⚠️ This session is running. Deletion stops its task and permanently removes its records.')
              : (zh
                ? '⚠️ 删除会永久移除会话记录，且无法恢复。'
                : '⚠️ Deletion permanently removes the session records and cannot be undone.'),
          ].join('\n'),
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [{
                tag: 'button',
                type: 'danger',
                text: { tag: 'plain_text', content: zh ? '确认删除' : 'Delete permanently' },
                value: { ...value, action: 'delete-confirm' },
              }],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [{
                tag: 'button',
                type: 'default',
                text: { tag: 'plain_text', content: zh ? '取消' : 'Cancel' },
                value: { ...value, action: 'delete-cancel' },
              }],
            },
          ],
        },
      ],
    };
  };
  return localizedCard({
    zhCn: { summary: '确认删除 DSH 会话', body: body('zh_cn') },
    enUs: { summary: 'Confirm DSH session deletion', body: body('en_us') },
  });
}

function safe(value: string, maxBytes: number): string {
  return truncateUtf8Safe(redactSecrets(value), maxBytes).replaceAll('```', '``\u200b`');
}
