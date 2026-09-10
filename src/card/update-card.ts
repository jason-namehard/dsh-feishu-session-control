import { localizedCard, type CardLocale } from './i18n.js';

export interface UpdateCardInput {
  scope: string;
  actorId: string;
  offerId: string;
  current: string;
  latest: string;
}

function body(input: UpdateCardInput, locale: CardLocale): Record<string, unknown> {
  const zh = locale === 'zh_cn';
  const value = (decision: 'confirm' | 'cancel') => ({
    cmd: 'channel-upgrade',
    decision,
    offerId: input.offerId,
    scope: input.scope,
    actorId: input.actorId,
  });
  return {
    elements: [
      {
        tag: 'markdown',
        content: zh
          ? `发现新版本：\`${input.current}\` → \`${input.latest}\`\n\n确认后将在当前 DSH 进程内更新包与运行时配置。更新完成后请从托盘重启 DSH 以加载新版本；会话、归档、配置与凭据不会被删除。`
          : `Update available: \`${input.current}\` → \`${input.latest}\`\n\nThe package and runtime profiles will be updated inside the current DSH process. Restart DSH from the tray afterward to load the new version; sessions, archives, configuration, and credentials are preserved.`,
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: zh ? '确认更新' : 'Confirm update' },
        type: 'primary',
        value: value('confirm'),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: zh ? '取消' : 'Cancel' },
        type: 'default',
        value: value('cancel'),
      },
    ],
  };
}

export function renderUpdateCard(input: UpdateCardInput): object {
  return localizedCard({
    zhCn: {
      summary: `dsh-lark-bot ${input.latest} 可更新`,
      header: { title: { tag: 'plain_text', content: '发现新版本' }, template: 'blue' },
      body: body(input, 'zh_cn'),
    },
    enUs: {
      summary: `dsh-lark-bot ${input.latest} is available`,
      header: { title: { tag: 'plain_text', content: 'Update available' }, template: 'blue' },
      body: body(input, 'en_us'),
    },
  });
}
