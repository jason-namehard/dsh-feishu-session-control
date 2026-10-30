/**
 * 0.2.0 客户端设置访问兼容层。
 *
 * 0.1.x 的客户端 `settingsScope` 服务在 0.2.0 被移除，设置改走
 * `remote.settings`（@deepseek-ai/dsh-api-settings-controller 生成的 RPC 命名空间：
 * describe / update / mutate / replace）。本文件用它重建 settings-card 依赖的
 * SettingsScope 表面（subscribe / getSnapshot / set / unset），
 * 让 useSyncExternalStore 无感继续工作。
 *
 * - 快照 = describe() 里本命名空间的 { value, user, revision }，缓存并保持引用稳定；
 * - 订阅 = 首个监听者出现时启动 5s 轮询（0.2.0 客户端无推送通道），全部退订即停止；
 * - set/unset = update / mutate（带 expectedRevision 冲突检测），写后立即刷新。
 */

export interface ScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable';
  value: T | undefined;
  user: Record<string, unknown> | undefined;
  writable: boolean;
  mode: 'host' | 'memory';
  lastError?: string;
}

type DescribeResult = {
  ok: true;
  value: {
    writable: boolean;
    hasDocument: boolean;
    namespaces: Array<{ ns: string; value?: unknown; user?: unknown; revision: number }>;
  };
} | { ok: false; error: unknown };

type WriteResult = {
  ok: true;
  value: { ns: string; value?: unknown; user?: unknown; revision: number };
} | { ok: false; error: unknown };

interface RemoteSettingsNamespace {
  describe: () => Promise<DescribeResult>;
  update: (ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined) => Promise<WriteResult>;
  mutate: (ns: string, ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>, expectedRevision: number | undefined) => Promise<WriteResult>;
}

function extractError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

export interface RemoteSettingsScope<T> {
  getSnapshot(): ScopeSnapshot<T>;
  subscribe(listener: () => void): () => void;
  set(key: string, value: unknown): Promise<void>;
  unset(key: string): Promise<void>;
  dispose(): void;
}

/** 0.2.0 里 `remote.settings` 是可注入服务（oc-panel 同款用法），这里防御式两种取法都支持。 */
function resolveRemoteSettings(ctx: unknown): RemoteSettingsNamespace {
  const get = (name: string): unknown => {
    const holder = ctx as { get?(name: string): unknown; [key: string]: unknown };
    if (typeof holder.get === 'function') return holder.get(name);
    return holder[name];
  };
  // oc-panel 的既有用法：先取 remote 服务再读 .settings，这条路径已在设置页验证可用。
  const remote = get('remote') as { settings?: RemoteSettingsNamespace } | undefined;
  if (remote?.settings && typeof remote.settings.describe === 'function') return remote.settings;
  const direct = get('remote.settings');
  if (direct && typeof (direct as RemoteSettingsNamespace).describe === 'function') return direct as RemoteSettingsNamespace;
  throw new Error('remote.settings namespace is unavailable in this client');
}

export function bindRemoteSettingsScope<T extends object>(ctx: unknown, namespace: string): RemoteSettingsScope<T> {
  const settings = resolveRemoteSettings(ctx);
  let snapshot: ScopeSnapshot<T> = { status: 'loading', value: undefined, user: undefined, writable: false, mode: 'host' };
  let lastError = '';
  let revision: number | undefined;
  let polling: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: ScopeSnapshot<T>): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  /** Publish only when the phase actually changed; reuse the snapshot object otherwise. */
  const setPhase = (status: ScopeSnapshot<T>['status'], writable: boolean): void => {
    if (snapshot.status === status && snapshot.writable === writable) return;
    publish({ ...snapshot, status, writable, lastError });
  };

  const refresh = async (): Promise<void> => {
    try {
      const described = await settings.describe();
      if (!described.ok) {
        const err = described.error as { message?: string; code?: string } | undefined;
        lastError = [err?.code, err?.message].filter(Boolean).join(': ') || 'describe rejected';
        setPhase('unavailable', false);
        return;
      }
      const view = described.value.namespaces.find((entry) => entry.ns === namespace);
      if (!view) { setPhase('unavailable', described.value.writable); return; }
      revision = view.revision;
      const value = (view.value ?? {}) as T;
      const user = (view.user ?? {}) as Record<string, unknown>;
      const changed = snapshot.status !== 'ready'
        || snapshot.writable !== described.value.writable
        || JSON.stringify(snapshot.value) !== JSON.stringify(value)
        || JSON.stringify(snapshot.user ?? {}) !== JSON.stringify(user);
      if (changed) lastError = '';
      publish({ status: 'ready', value, user, writable: described.value.writable, mode: 'host' });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      setPhase('unavailable', false);
    }
  };

  // 绑定即预热一次快照（轮询仍由首个订阅者启动）。
  void refresh();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        polling = setInterval(() => { void refresh(); }, 15000);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && polling) {
          clearInterval(polling);
          polling = undefined;
        }
      };
    },
    async set(key: string, value: unknown) {
      const written = await settings.update(namespace, { [key]: value }, revision);
      if (!written.ok) throw new Error(extractError(written.error));
      revision = written.value.revision;
      await refresh();
    },
    async unset(key: string) {
      const written = await settings.mutate(namespace, [{ op: 'unset', path: [key] }], revision);
      if (!written.ok) throw new Error(extractError(written.error));
      revision = written.value.revision;
      await refresh();
    },
    dispose() {
      if (polling) {
        clearInterval(polling);
        polling = undefined;
      }
      listeners.clear();
    },
  };
}
