import type { DshSessionSummary } from '../session/projection-protocol.js';
import { redactSecrets, truncateUtf8Safe } from '../config/security.js';
import { localizedCard, type CardLocale } from './i18n.js';

export function renderSessionDeleteConfirmCard(input: {
  alias: string;
  session: DshSessionSummary;
  mode: 'trash' | 'purge';
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
    const permanent = input.mode === 'purge';
    const value = {
      cmd: 'session-alias',
      alias: input.alias,
      nonce: input.nonce,
      scope: input.scope,
      workspaceCwd: input.workspaceCwd,
      actorId: input.actorId,
      mode: input.mode,
    };
    return {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${zh ? (permanent ? '确认永久删除会话' : '确认移入回收站') : (permanent ? 'Confirm permanent deletion' : 'Confirm move to recycle bin')}**`,
            '',
            `${zh ? '别名' : 'Alias'}: **\`${safe(input.alias, 128)}\`**`,
            `${zh ? '名称' : 'Name'}: ${safe(title, 256)}`,
            `${zh ? '状态' : 'Status'}: ${status}`,
            `${zh ? '真实会话 ID' : 'Native session ID'}: \`${safe(input.session.sessionId, 256)}\``,
            '',
            input.session.running
              ? (zh
                ? (permanent
                  ? '⚠️ 该会话正在运行。任务会先停止，然后永久移除会话记录。'
                  : '⚠️ 该会话正在运行。任务会先停止，然后移入可恢复的回收站。')
                : (permanent
                  ? '⚠️ 会话记录将被永久移除，且无法恢复。'
                  : 'ℹ️ 会话将移入回收站，可从 DSH Web 会话管理器恢复。'))
              : (zh
                ? (permanent ? '⚠️ 会话记录将被永久移除，且无法恢复。' : 'ℹ️ 会话将移入回收站，可从 DSH Web 会话管理器恢复。')
                : (permanent ? '⚠️ The session records will be permanently removed and cannot be recovered.' : 'ℹ️ The session will move to the recycle bin and can be restored from the DSH Web session manager.')),
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
                text: { tag: 'plain_text', content: zh ? (permanent ? '永久删除' : '移入回收站') : (permanent ? 'Delete permanently' : 'Move to recycle bin') },
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

/**
 * What a confirmation card becomes once its button has been pressed.
 *
 * A card whose buttons are still there after the operation ran reads as
 * "nothing happened": the only feedback is a toast, which is gone in a second
 * and never says which of several open cards it belonged to. Replacing the
 * card body with the outcome — and dropping the buttons — is how the approval
 * and update cards already settle, so /use, /delete and /purge now settle the
 * same way.
 */
export function renderSessionOutcomeCard(input: { zh: string; en: string }): object {
  return localizedCard({
    zhCn: { summary: '会话操作结果', body: { elements: [{ tag: 'markdown', content: input.zh }] } },
    enUs: { summary: 'Session action result', body: { elements: [{ tag: 'markdown', content: input.en }] } },
  });
}
