import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { RemoteSettingsScope, ScopeSnapshot } from './settings-scope-compat.js';

export const SETTINGS_NAMESPACE = 'dsh-lark-bot';

type SettingKey =
  | 'tenant'
  | 'appId'
  | 'appSecret'
  | 'workspace'
  | 'model'
  | 'scopeConcurrency'
  | 'adapter'
  | 'notificationDefault';

export interface SettingsField {
  key: SettingKey;
  label: string;
  help: string;
  timing: string;
  secret?: boolean;
}

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  { key: 'tenant', label: '服务区域 / Region', help: '中国大陆选飞书，海外工作区选 Lark。', timing: '保存后自动重连生效' },
  { key: 'appId', label: '应用 ID / App ID', help: '飞书开放平台中以 cli_ 开头的应用 ID。', timing: '保存后自动重连生效' },
  { key: 'appSecret', label: '应用密钥 / App Secret', help: '只写不回显；留空不会覆盖已保存密钥。', timing: '保存后自动重连生效', secret: true },
  { key: 'workspace', label: '默认项目文件夹 / Workspace', help: '新会话默认打开的本机项目目录。', timing: '新会话生效（保存后自动重连）' },
  { key: 'model', label: '默认模型 / Model', help: '新任务使用的 provider/model 路由。', timing: '保存后热更新，下一任务生效' },
  { key: 'scopeConcurrency', label: '并行任务数 / Parallel tasks', help: '每个飞书会话同时运行的任务数，建议 1-4。', timing: '保存后立即生效于新任务' },
  { key: 'adapter', label: '运行方式 / Runtime mode', help: '默认使用当前 dsh Web；只有需要独立 SDK runtime 时才选择 sdk。', timing: '保存后自动重连生效' },
  { key: 'notificationDefault', label: '默认提醒 / Notifications', help: '会话未单独设置时，是否主动提醒完成、失败和审批。', timing: '保存后立即生效于新提醒' },
] as const;

export const DIAGNOSTIC_SHORTCUTS = [
  { command: '/status', label: 'Bot 没反应：查看连接与运行状态' },
  { command: '/doctor', label: '任务失败：生成脱敏诊断包' },
] as const;

export interface BrowserSettings {
  tenant?: 'feishu' | 'lark';
  appId?: string;
  workspace?: string;
  model?: string;
  scopeConcurrency?: number;
  adapter?: 'sdk' | 'acp' | 'headless' | 'web';
  notificationDefault?: 'off' | 'completed' | 'all';
}

type SettingsDraft = Partial<Record<SettingKey, string>>;

/** Normalize a browser form without ever manufacturing an empty secret write. */
export function normalizeSettingsDraft(draft: SettingsDraft): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(draft)) {
    const value = raw.trim();
    if (!value) continue;
    if (key === 'scopeConcurrency') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
        throw new Error('并行任务数必须是 1 到 32 的整数。');
      }
      output[key] = parsed;
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function draftFrom(value: BrowserSettings | undefined): SettingsDraft {
  return {
    tenant: value?.tenant ?? 'feishu',
    appId: value?.appId ?? '',
    appSecret: '',
    workspace: value?.workspace ?? '',
    model: value?.model ?? '',
    scopeConcurrency: value?.scopeConcurrency === undefined ? '' : String(value.scopeConcurrency),
    adapter: value?.adapter ?? 'web',
    notificationDefault: value?.notificationDefault ?? 'off',
  };
}

export interface BrowserDiagnosticSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value: BrowserSettings | undefined;
  writable: boolean;
  mode: 'host' | 'memory';
}

/** A direct, secret-free Web diagnosis; Feishu commands remain the deep fallback. */
export function buildWebDiagnostic(snapshot: BrowserDiagnosticSnapshot): string {
  if (snapshot.status !== 'ready') {
    return '⚠️ Web 尚未连接到插件设置。请确认插件已启用并刷新页面；远程页面不可用时请回到运行 dsh 的主机。';
  }
  const value = snapshot.value ?? {};
  const findings: string[] = [];
  if (!value.appId) findings.push('未检测到 App ID，请先填写飞书/Lark 应用 ID。');
  if (!value.workspace) findings.push('未设置默认项目文件夹；新任务可能无法进入预期项目。');
  if (!value.model) findings.push('未设置默认模型；将继承 dsh/profile 默认值。');
  if (snapshot.mode === 'memory' || !snapshot.writable) {
    findings.push('当前是远端只读视图；修改设置需打开运行 dsh 的本机 Web。');
  }
  if (findings.length === 0) {
    return `✅ 页面配置检查通过：${value.tenant ?? 'feishu'} / ${value.adapter ?? 'web'}，App ID、工作目录和模型均已配置。App Secret 按安全策略不回显；如 bot 仍无响应，请重新填写密钥后保存，或在飞书运行 /status。`;
  }
  return `⚠️ 页面配置发现 ${findings.length} 项：\n${findings.map((item) => `• ${item}`).join('\n')}\nApp Secret 按安全策略不回显；连接失败时可重新填写后保存。`;
}

export function canSaveSnapshot(snapshot: Pick<BrowserDiagnosticSnapshot, 'status' | 'writable'>): boolean {
  return snapshot.status === 'ready' && snapshot.writable;
}

export async function saveSettingsDraft(
  scope: Pick<RemoteSettingsScope<BrowserSettings>, 'set' | 'unset'>,
  snapshot: Pick<ScopeSnapshot<BrowserSettings>, 'value' | 'user'>,
  draft: SettingsDraft,
): Promise<void> {
  const normalized = normalizeSettingsDraft(draft);
  const current = (snapshot.value ?? {}) as Record<string, unknown>;
  const user = snapshot.user && typeof snapshot.user === 'object'
    ? snapshot.user as Record<string, unknown>
    : {};
  for (const field of SETTINGS_FIELDS) {
    if (field.secret && normalized[field.key] === undefined) continue;
    const next = normalized[field.key];
    if (next === undefined) {
      if (field.key in user) await scope.unset(field.key);
    } else if (field.secret || current[field.key] !== next) {
      await scope.set(field.key, next);
    }
  }
}

/** dsh browser-half entry：0.2.0 起飞书设置卡按用户决定退役（连接开关移至系统托盘）。
 *  字段/草稿/诊断工具函数与其测试保留；remote.settings 兼容层见 settings-scope-compat.ts。 */
export function apply(_ctx: ClientContext): void {
  /* retired: no settings-page mount */
}
