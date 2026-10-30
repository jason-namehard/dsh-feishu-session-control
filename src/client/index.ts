import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { apply as applyPluginManager, inject as pluginManagerInject } from '../plugin-manager/client.js';
import { apply as applySessionManager, inject as sessionManagerInject } from '../integrated/session-manager/client/index.js';

// settings-card 已退役（0.2.0 飞书连接开关移至系统托盘），不再参与本入口的注入与挂载。

export const inject = [...new Set([...pluginManagerInject, ...sessionManagerInject])];

export function apply(ctx: ClientContext): void {
  applyPluginManager(ctx);
  applySessionManager(ctx);
}
