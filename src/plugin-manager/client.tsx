import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { useCallback, useEffect, useMemo, useState } from 'react'

type PluginEntry = {
  entryId: string
  moduleName: string
  packageName: string
  version: string | null
  description: string
  enabled: boolean
  fiberPhase: string | null
  protected: boolean
  canDisable: boolean
  canUninstall: boolean
  permissions: string[]
}

type PluginSnapshot = {
  profile: string | null
  hotInstallerActive: boolean
  entries: PluginEntry[]
}

type PackageGroup = {
  packageName: string
  version: string | null
  description: string
  permissions: string[]
  canUninstall: boolean
  entries: PluginEntry[]
}

async function pluginRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/dsh-plugin-manager/${path}`, init)
  let body: { ok?: boolean; error?: string } & T
  try {
    body = await response.json() as typeof body
  } catch {
    throw new Error(`插件管家请求失败：HTTP ${response.status}`)
  }
  if (!response.ok || body.ok !== true) throw new Error(body.error || `插件管家请求失败：HTTP ${response.status}`)
  return body
}

function phaseLabel(phase: string | null): string {
  if (phase === 'active') return '运行中'
  if (phase === 'failed') return '启动失败'
  if (phase === 'loading') return '加载中'
  if (phase === 'unloading') return '卸载中'
  if (phase === 'pending') return '等待依赖'
  return '未运行'
}

function PluginManagerTab() {
  const [snapshot, setSnapshot] = useState<PluginSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [spec, setSpec] = useState('')
  const [confirmRisk, setConfirmRisk] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await pluginRequest<PluginSnapshot>('list'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const groups = useMemo<PackageGroup[]>(() => {
    const grouped = new Map<string, PackageGroup>()
    for (const entry of snapshot?.entries ?? []) {
      const current = grouped.get(entry.packageName)
      if (current) {
        current.entries.push(entry)
        current.canUninstall ||= entry.canUninstall
        if (current.permissions.length === 0) current.permissions = entry.permissions
      } else {
        grouped.set(entry.packageName, {
          packageName: entry.packageName,
          version: entry.version,
          description: entry.description,
          permissions: entry.permissions,
          canUninstall: entry.canUninstall,
          entries: [entry],
        })
      }
    }
    return [...grouped.values()].sort((left, right) => left.packageName.localeCompare(right.packageName))
  }, [snapshot])

  // 按包名 / 描述 / 模块名过滤，空格分隔的多个词需全部命中。
  const visibleGroups = useMemo<PackageGroup[]>(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return groups
    return groups.filter((group) => {
      const haystack = [
        group.packageName,
        group.description ?? '',
        ...group.entries.map((entry) => entry.moduleName),
      ].join(' ').toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [groups, query])

  const toggle = async (entry: PluginEntry) => {
    if (!entry.canDisable || working) return
    setWorking(entry.entryId)
    setError(null)
    setMessage(null)
    try {
      await pluginRequest('toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryId: entry.entryId, enabled: !entry.enabled }),
      })
      setMessage(`${entry.moduleName} 已${entry.enabled ? '停用' : '启用'}，热生效`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWorking(null)
    }
  }

  const uninstall = async (group: PackageGroup) => {
    if (!group.canUninstall || working) return
    if (!window.confirm(`确认卸载 ${group.packageName}？其所有 Loader 条目会被热卸载。`)) return
    setWorking(`uninstall:${group.packageName}`)
    setError(null)
    setMessage(null)
    try {
      await pluginRequest('uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageName: group.packageName }),
      })
      setMessage(`${group.packageName} 已卸载，热生效`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWorking(null)
    }
  }

  const install = async () => {
    if (working || !spec.trim()) return
    setWorking('install')
    setError(null)
    setMessage(null)
    try {
      const result = await pluginRequest<{ message?: string }>('install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: spec.trim(), confirmRisk }),
      })
      setSpec('')
      setConfirmRisk(false)
      setMessage(result.message || '插件已安装，热生效')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWorking(null)
    }
  }

  return (
    <section style={styles.root}>
      <header style={styles.header}>
        <div>
          <h2 style={styles.title}>插件管家</h2>
          <p style={styles.subtitle}>查看、停用、启用和安全卸载当前 DSH profile 的插件。停启默认热生效，浏览器端插件可能需要刷新页面。</p>
        </div>
        <button type="button" style={styles.secondaryButton} disabled={loading || working !== null} onClick={() => { void load() }}>刷新</button>
      </header>

      <section style={styles.installCard}>
        <strong>安装插件</strong>
        <p style={styles.help}>只接受精确的 registry package@version；安装会禁用 npm 生命周期脚本，并检查 DSH 兼容声明和 bundle patch。</p>
        <div style={styles.installRow}>
          <input style={styles.input} value={spec} placeholder="例如 @scope/plugin@1.2.3" onChange={(event) => { setSpec(event.currentTarget.value) }} />
          <button type="button" style={styles.primaryButton} disabled={working !== null || !spec.trim() || !confirmRisk} onClick={() => { void install() }}>{working === 'install' ? '安装中…' : '安装并热加载'}</button>
        </div>
        <label style={styles.checkLabel}>
          <input type="checkbox" checked={confirmRisk} onChange={(event) => { setConfirmRisk(event.currentTarget.checked) }} />
          我已确认包来源、权限声明和当前 DSH 兼容版本；插件代码仍会以 DSH 插件权限运行
        </label>
      </section>

      {!loading && groups.length > 0 && (
        <div style={styles.searchRow}>
          <input
            type="search"
            style={styles.input}
            value={query}
            placeholder="搜索插件…（包名 / 描述 / 模块名，空格分隔多个关键词）"
            aria-label="搜索插件"
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
          {query.trim() !== '' && (
            <span style={styles.searchMeta}>匹配 {visibleGroups.length} / {groups.length}</span>
          )}
        </div>
      )}

      {error && <div role="alert" style={styles.error}>{error}</div>}
      {message && <div role="status" style={styles.message}>{message}</div>}
      {loading && <p style={styles.help}>正在读取插件清单…</p>}
      {!loading && groups.length === 0 && <p style={styles.help}>当前没有可管理的插件。</p>}
      {!loading && groups.length > 0 && visibleGroups.length === 0 && <p style={styles.help}>没有匹配「{query.trim()}」的插件。</p>}
      {!loading && visibleGroups.map((group) => (
        <article key={group.packageName} style={styles.card}>
          <div style={styles.packageHeader}>
            <div style={styles.packageTitle}>
              <strong>{group.packageName}</strong>
              {group.version && <span style={styles.version}>v{group.version}</span>}
            </div>
            {group.canUninstall && <button type="button" style={styles.dangerButton} disabled={working !== null} onClick={() => { void uninstall(group) }}>{working === `uninstall:${group.packageName}` ? '卸载中…' : '安全卸载'}</button>}
          </div>
          <p style={styles.description}>{group.description}</p>
          {group.permissions.length > 0 && <p style={styles.permission}>声明权限：{group.permissions.join('、')}</p>}
          {group.entries.map((entry) => (
            <div key={entry.entryId} style={styles.entry}>
              <div style={styles.entryMain}>
                <code style={styles.module}>{entry.moduleName}</code>
                <span style={styles.state}>{entry.enabled ? '已启用' : '已停用'} · {phaseLabel(entry.fiberPhase)}</span>
              </div>
              {entry.protected ? <span style={styles.protected}>核心保护</span> : <button type="button" style={styles.secondaryButton} disabled={!entry.canDisable || working !== null} onClick={() => { void toggle(entry) }}>{working === entry.entryId ? '处理中…' : entry.enabled ? '停用（热生效）' : '启用（热生效）'}</button>}
            </div>
          ))}
        </article>
      ))}
      {snapshot && <p style={styles.footer}>Profile：{snapshot.profile || '当前'} · {snapshot.hotInstallerActive ? '热安装器在线' : '新增/卸载可能需要重启'}</p>}
    </section>
  )
}

const styles = {
  root: { display: 'grid', gap: 14, width: '100%', maxWidth: 820, color: 'var(--dsw-alias-label-primary)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 },
  title: { margin: 0, fontSize: 18 },
  subtitle: { margin: '6px 0 0', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.6 },
  installCard: { display: 'grid', gap: 8, padding: 14, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-2)' },
  installRow: { display: 'flex', gap: 8, alignItems: 'center' },
  searchRow: { display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 2px' },
  searchMeta: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' as const },
  input: { minWidth: 0, flex: 1, boxSizing: 'border-box' as const, minHeight: 36, padding: '0 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', color: 'inherit', font: 'inherit' },
  checkLabel: { display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5 },
  help: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.6 },
  card: { display: 'grid', gap: 10, padding: 14, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-3)' },
  packageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  packageTitle: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 },
  version: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
  description: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  permission: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  entry: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2)' },
  entryMain: { display: 'grid', gap: 3, minWidth: 0 },
  module: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  state: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  protected: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, whiteSpace: 'nowrap' },
  primaryButton: { border: 0, borderRadius: 8, padding: '8px 12px', background: 'var(--dsw-alias-brand-primary, #1456a0)', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' },
  secondaryButton: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '7px 10px', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' },
  dangerButton: { border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)', borderRadius: 8, padding: '7px 10px', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer', whiteSpace: 'nowrap' },
  error: { padding: '9px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
  message: { padding: '9px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)', color: 'var(--dsw-alias-label-primary)', fontSize: 12 },
  footer: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
} as const

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'dsh-plugin-manager',
    order: 20,
    label: () => '插件管家',
  }, PluginManagerTab))
}
