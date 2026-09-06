import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { apply as applySettings, inject as settingsInject } from './settings-card.js';
import { apply as applySessionManager, inject as sessionManagerInject } from '../integrated/session-manager/client/index.js';

export const inject = [...new Set([...settingsInject, ...sessionManagerInject])];

export function apply(ctx: ClientContext): void {
  applySettings(ctx);
  applySessionManager(ctx);
}
