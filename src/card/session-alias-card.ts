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
 * Pick one session out of several whose titles all matched what was typed.
 *
 * `/use DSH` can legitimately match more than one session. Answering that with a
 * thrown error line left the reader holding aliases to retype — on a phone, that
 * means reading an alias off one message and typing it into another. Every
 * candidate becomes its own full-width row, so the choice is a tap.
 *
 * Rows rather than a row of side-by-side buttons: a `column_set` folds its
 * overflow into a "more" menu once it holds more than a couple of columns, which
 * hides exactly the options the card exists to show. One element per line has no
 * such limit.
 *
 * Picking still leads to the ordinary confirmation card — this card only
 * answers "which session did you mean", never "rebind now" — and the cancel
 * button abandons the pick without touching the binding.
 */
export function renderSessionCandidateCard(input: {
  /** What the operator typed; omitted by bare `/use`, which lists everything. */
  argument?: string;
  candidates: ReadonlyArray<{ sessionId: string; alias?: string; title?: string }>;
  scope: string;
  workspaceCwd: string;
  actorId: string;
  /** Candidates past this many are omitted from the card entirely. */
  maxButtons?: number;
}): object {
  const maxButtons = input.maxButtons ?? 20;
  const shown = input.candidates.slice(0, maxButtons);
  const body = (locale: CardLocale) => {
    const zh = locale === 'zh_cn';
    const heading = input.argument === undefined
      ? (zh
        ? `**选择一个会话绑定到本对话**（共 ${input.candidates.length} 个）`
        : `**Pick a session to bind to this chat** (${input.candidates.length} available)`)
      : (zh
        ? `**\`${safe(input.argument, 64)}\` 匹配到 ${input.candidates.length} 个会话，请选一个**`
        : `**\`${safe(input.argument, 64)}\` matches ${input.candidates.length} sessions — pick one**`);
    const omitted = input.candidates.length - shown.length;
    return {
      elements: [
        {
          tag: 'markdown',
          content: [
            heading,
            '',
            zh
              ? '选择后会再弹一张确认卡，确认前不会改变绑定。'
              : 'Picking opens the usual confirmation card; nothing is rebound until you confirm it.',
            ...(omitted > 0
              ? [zh
                ? `（卡片最多显示 ${maxButtons} 个；其余请用完整 session id）`
                : `(the card shows at most ${maxButtons}; use a full session id for the rest)`]
              : []),
          ].join('\n'),
        },
        ...shown.map((candidate) => {
          const label = candidateLabel(candidate);
          return {
            tag: 'button',
            type: 'primary',
            width: 'fill',
            text: { tag: 'plain_text', content: safe(label, 60) },
            value: {
              cmd: 'session-alias',
              action: 'use-pick',
              sessionId: candidate.sessionId,
              label,
              scope: input.scope,
              workspaceCwd: input.workspaceCwd,
              actorId: input.actorId,
            },
          };
        }),
        {
          tag: 'button',
          type: 'default',
          width: 'fill',
          text: { tag: 'plain_text', content: zh ? '取消' : 'Cancel' },
          value: {
            cmd: 'session-alias',
            action: 'use-cancel',
            scope: input.scope,
            workspaceCwd: input.workspaceCwd,
            actorId: input.actorId,
          },
        },
      ],
    };
  };
  return localizedCard({
    zhCn: { summary: '选择 DSH 会话', body: body('zh_cn') },
    enUs: { summary: 'Choose a DSH session', body: body('en_us') },
  });
}

/**
 * One candidate's row label.
 *
 * The alias alone does not say which conversation it is, and the title alone
 * cannot be typed elsewhere, so the row carries both. An unaliased session has
 * no short handle to lead with, so its title leads instead.
 */
function candidateLabel(candidate: { sessionId: string; alias?: string; title?: string }): string {
  const title = candidate.title?.trim();
  if (candidate.alias !== undefined) {
    return title === undefined || title === '' ? candidate.alias : `${candidate.alias} · ${title}`;
  }
  return title === undefined || title === '' ? candidate.sessionId : title;
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

/**
 * Ask for a session's name in a text field on the card.
 *
 * The alternative is telling someone to retype `/rename 0908-1 <name>`, which
 * on a phone means reading an alias off one message and typing it into
 * another. Here the alias is already bound to the card, so only the name has
 * to be typed — and submitting it empty is a valid answer, meaning "leave
 * dsh's own naming alone".
 *
 * The input and its submit button sit inside a `form`: card JSON 2.0 only
 * returns a field's value in the callback when a submit-bound button collects
 * it from the same form.
 */
export function renderSessionNameCard(input: {
  alias: string;
  sessionId: string;
  currentTitle?: string;
  nonce: string;
  scope: string;
  workspaceCwd: string;
  actorId: string;
  /** A session just created by /new, as opposed to renaming an existing one. */
  fresh?: boolean;
}): object {
  const body = (locale: CardLocale) => {
    const zh = locale === 'zh_cn';
    const current = input.currentTitle?.trim();
    return {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${zh
              ? (input.fresh ? '给新会话起个名字' : '重命名会话')
              : (input.fresh ? 'Name the new session' : 'Rename session')}**`,
            '',
            `${zh ? '别名' : 'Alias'}: **\`${safe(input.alias, 128)}\`**`,
            ...(current
              ? [`${zh ? '当前名称' : 'Current name'}: ${safe(current, 256)}`]
              : []),
            '',
            zh
              ? '名称会写入 DSH，网页端会话列表同步显示。留空提交则保留 DSH 的默认命名。'
              : 'The name is written to DSH and appears in the Web session list. Submit it empty to keep dsh’s own naming.',
          ].join('\n'),
        },
        {
          tag: 'form',
          name: `form-rename-${input.nonce}`,
          elements: [
            {
              tag: 'input',
              name: 'title',
              max_length: 120,
              default_value: current ?? '',
              placeholder: {
                tag: 'plain_text',
                content: zh ? '例如：登录接口重构' : 'e.g. Refactor the login endpoint',
              },
            },
            {
              tag: 'button',
              type: 'primary',
              text: { tag: 'plain_text', content: zh ? '保存名称' : 'Save name' },
              form_action_type: 'submit',
              name: `btn-rename-${input.nonce}`,
              value: {
                cmd: 'session-rename',
                action: 'rename-submit',
                alias: input.alias,
                nonce: input.nonce,
                scope: input.scope,
                workspaceCwd: input.workspaceCwd,
                actorId: input.actorId,
              },
            },
          ],
        },
      ],
    };
  };
  return localizedCard({
    zhCn: { summary: '会话命名', body: body('zh_cn') },
    enUs: { summary: 'Session name', body: body('en_us') },
  });
}
