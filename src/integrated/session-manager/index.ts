// @ts-nocheck
// dsh-sessions-manager — host half.
//
// Serves /archived-sessions/* JSON routes (list / restore / restore-many /
// delete / delete-many / sessions / workspaces / move) over the host
// `webServer`. The browser Settings sections ("归档会话" & "移动会话") talk to
// these. Reads/writes the durable workspace archive set
// (workspaceRegistry + storageDomain), folds titles/dates/workspace tags from
// session persistence, physically removes a session's log file on delete, and
// relocates a conversation (session) between workspaces on move.
import { mkdir, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { readSessionLogFile, rewriteFrame0Cwd } from './zstd-frame.js'
import { renderSessionMarkdown } from './markdown.js'
import { createStarIndex } from './star-index.js'
import { ColdSessionStore } from './cold-storage.js'
import { sessionHeaderList, sessionIdOf, unwrapSessionHeader } from '../../session/session-metadata.js'
import { registerSessionCore, type SessionCore } from '../../session-core/index.js'

export const name = 'dsh-sessions-manager'
// Services this host half cannot work without. Declaring them as the
// plugin's inject set makes cordis defer activation until every one is
// live, instead of the module loading early, reading undefined out of
// ctx.get(), and silently registering no routes (which is how the
// Settings panels and /__chameleon/* endpoints vanished after the DSH
// 0.1.2-rc.1 repackaging moved session persistence/query into new
// packages and changed their activation order).
export const inject = [
  'webServer',
  'workspaceRegistry',
  'sessionPersistence',
  'sessionQuery',
  'storageDomain',
  'sessionController',
]

const MAX_TITLE = 80
// Recycle bin (回收站): normal deletes land here instead of being erased.
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const COLD_STORE = new ColdSessionStore(DSH_HOME)
const LIGHT_ROWS_TTL_MS = 30 * 60_000
// -- per-session detail aggregation (v2.0: 取 Zephyr-vibe buildDetails 精华) --
// 识别“搜索/抓取”类工具，用来收集 fetch 记录。
const FETCH_TOOL_RE = /search|fetch|download|browse/i
const MAX_FETCHES = 12   // fetch 记录上限（防响应过大）
const MAX_FILES = 20     // write/edit 文件列表上限

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function errorStatus(error) {
  return error && Number.isInteger(error.status) ? error.status : 500
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    chunks.push(chunk)
    total += chunk.length
    if (total > 1 << 20) return null
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function parseIds(body) {
  const raw = body && body.sessionIds
  if (!Array.isArray(raw)) return null
  const ids = []
  for (const v of raw) if (typeof v === 'string' && isSafeSessionId(v)) ids.push(v)
  return ids
}

function isSafeSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\\/\0]/.test(value) && value !== '.' && value !== '..'
}

function requireSessionId(value) {
  if (!isSafeSessionId(value)) {
    const error = new Error('无效的 sessionId')
    error.status = 400
    throw error
  }
  return value
}

// Best-effort: figure out which conversation is the host's *currently active*
// one. DSH's in-memory session store (ctx.sessions) keeps EVERY instantiated
// session alive even after you switch away in the UI, so "is it in
// ctx.sessions" is NOT the same as "is it the active conversation". We probe a
// few known accessors for the active id; if none is available we return null
// and callers should treat the session as movable (the move path is
// crash-safe via backup+rollback and re-syncs the live object afterwards).
function getActiveSessionId(context) {
  try {
    const a = context.get('activeSession')
    if (a != null) return (a && a.id != null) ? a.id : (typeof a === 'string' ? a : null)
  } catch (e) { /* no such key */ }
  try {
    const c = context.get('currentSession')
    if (c != null) return (c && c.id != null) ? c.id : (typeof c === 'string' ? c : null)
  } catch (e) { /* no such key */ }
  try {
    const store = context.get('sessions')
    if (store && store.active && store.active.id != null) return store.active.id
  } catch (e) { /* no such key */ }
  return null
}

function foldTitle(events) {
  let found = null
  let firstUser = null
  for (const ev of events) {
    if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.length) {
      found = ev.data.title
    }
    if (firstUser === null && ev.type === 'user/message' && ev.data && Array.isArray(ev.data.content)) {
      const txt = ev.data.content.filter((b) => b && b.type === 'text').map((b) => b.text).filter(Boolean).join(' ').trim()
      if (txt) firstUser = txt
    }
  }
  return found || firstUser || null
}

/**
 * Wait until every service this entry needs is published, then mount.
 *
 * dsh 0.1.5 publishes `sessionPersistence` / `sessionQuery` / `storageDomain`
 * asynchronously — a few hundred ms AFTER the plugin tree reports ready. The
 * previous synchronous read ran at apply time, found nothing, and silently
 * returned, so the whole session manager stayed unmounted on 0.1.5 while
 * `plugin` (which reads lazily) kept working. Retry instead of giving up once.
 */
const REQUIRED_SERVICES = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessionQuery', 'storageDomain', 'sessionController']

function contextService(ctx: { get?: (n: string) => unknown }, name: string): unknown {
  const direct = (ctx as unknown as Record<string, unknown>)[name]
  if (direct !== undefined) return direct
  try { return ctx.get?.(name) } catch { return undefined }
}

function readServices(ctx: { get?: (n: string) => unknown }): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const name of REQUIRED_SERVICES) {
    const value = contextService(ctx, name)
    if (value === undefined || value === null) return undefined
    out[name] = value
  }
  return out
}

export function apply(ctx) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(REQUIRED_SERVICES, (serviceContext) => {
      const services = readServices(serviceContext as { get?: (n: string) => unknown })
      if (services) mount(serviceContext, services)
    })
    return
  }
  const services = readServices(ctx as { get?: (n: string) => unknown })
  if (services) mount(ctx, services)
}

function mount(ctx, services: Record<string, unknown>) {
  const webServer = services.webServer
  const w = services.workspaceRegistry
  const sp = services.sessionPersistence
  const sq = services.sessionQuery
  const storageDomain = services.storageDomain
  const sessionController = services.sessionController
  const dom = () => storageDomain.get('workspace')
  const authorityTitleCache = new Map()
  let authorityTitlesLoaded = false
  let lightRowsCache = null
  let lightRowsInflight = null
  const invalidateLightRows = () => { lightRowsCache = null }

  async function lightSessionRows() {
    const now = Date.now()
    if (lightRowsCache && now - lightRowsCache.at < LIGHT_ROWS_TTL_MS) return lightRowsCache.rows
    if (lightRowsInflight) return lightRowsInflight
    lightRowsInflight = (async () => {
      let rows = []
      if (sessionController && typeof sessionController.list === 'function') {
        const result = await sessionController.list()
        rows = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
      } else if (sq && typeof sq.listSessions === 'function') {
        const records = await sq.listSessions()
        rows = Array.isArray(records) ? records : []
      }
      lightRowsCache = { at: Date.now(), rows }
      return rows
    })().finally(() => { lightRowsInflight = null })
    return lightRowsInflight
  }

  async function persistedHeaders() {
    try { return sessionHeaderList(await sp.list()) } catch (e) { return [] }
  }

  async function persistedHeader(sessionId) {
    try {
      const row = (await lightSessionRows()).find((item) => String(item.sessionId ?? item.header?.id) === String(sessionId))
      if (row) {
        const header = row.header && typeof row.header === 'object' ? row.header : row
        const projectedTitle = row.projections?.values?.title
        return Object.assign({}, header, {
          id: String(row.sessionId ?? header.id),
          ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
          ...(typeof projectedTitle === 'string' && projectedTitle.trim() ? { title: projectedTitle.trim() } : {}),
          ...(typeof row.createdAt === 'number' ? { createdAt: row.createdAt } : {}),
          ...(typeof row.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}),
          ...(typeof row.parentSessionId === 'string' ? { parentSession: row.parentSessionId } : {}),
          ...(typeof row.origin === 'string' ? { origin: row.origin } : {}),
        })
      }
    } catch (e) { /* fall back to the persistence snapshot */ }
    return (await persistedHeaders()).find((header) => sessionIdOf(header) === String(sessionId)) || null
  }

  async function readStoredSession(sessionId) {
    if (sp && typeof sp.open === 'function') {
      const handle = await sp.open(sessionId, 'read')
      try {
        const result = await handle.read(0)
        return {
          meta: result?.meta || handle.header || null,
          events: Array.isArray(result?.events) ? result.events : [],
        }
      } finally {
        await handle.close()
      }
    }
    if (sp && typeof sp.readFrom === 'function') return sp.readFrom(sessionId, 0)
    throw new Error('DSH session persistence does not expose a readable handle')
  }

  function headerField(header, key) {
    const value = unwrapSessionHeader(header)?.[key]
    return value === undefined || value === null ? undefined : value
  }

  function headerWorkspace(header) {
    const cwd = headerField(header, 'cwd')
    if (typeof cwd === 'string' && cwd) return cwd
    const meta = headerField(header, 'meta')
    const metaCwd = meta && typeof meta === 'object' ? meta.cwd : undefined
    return typeof metaCwd === 'string' && metaCwd ? metaCwd : null
  }

  function headerTitle(header) {
    const direct = headerField(header, 'title')
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const meta = headerField(header, 'meta')
    const metaTitle = meta && typeof meta === 'object' ? meta.title : undefined
    return typeof metaTitle === 'string' && metaTitle.trim() ? metaTitle.trim() : null
  }

  async function sessionLocation(header) {
    try {
      const located = sp.locate(header)
      if (located && typeof located.path === 'string') return located.path
    } catch (e) {}
    return null
  }

  async function detachBeforeMove(sid) {
    const activeId = getActiveSessionId(ctx)
    if (activeId != null && String(activeId) === String(sid)) {
      const error = new Error('该会话当前处于打开状态，请先切换到别的会话再操作。')
      error.status = 409
      throw error
    }
    const sessions = ctx.get('sessions')
    const liveSession = sessions && sessions.get && sessions.get(sid)
    if (!liveSession) return
    const status = String(liveSession.status || liveSession.state || '').toLowerCase()
    if (['running', 'working', 'busy', 'loading'].includes(status)) {
      const error = new Error('该会话正在运行，请等待完成后再操作。')
      error.status = 409
      throw error
    }
    if (typeof sessions.flush === 'function') await sessions.flush(liveSession)
    const entered = sessions.store && sessions.store.get && sessions.store.get(sid)
    if (entered && typeof entered.detach === 'function') entered.detach()
    const retirement = sp.retirements && sp.retirements.get && sp.retirements.get(sid)
    if (retirement && typeof retirement.then === 'function') await retirement
  }

  async function reindexAfterColdMove(restored = null) {
    try {
      const reg = w
      if (reg && typeof reg.replaceHeaderIndex === 'function') {
        const rows = await lightSessionRows()
        const hiddenIds = new Set([
          ...(await COLD_STORE.list('archive')).map((item) => String(item.sessionId)),
          ...(await COLD_STORE.list('trash')).map((item) => String(item.sessionId)),
        ])
        const headers = rows.flatMap((row) => {
          const raw = row?.header && typeof row.header === 'object' ? row.header : row
          const id = String(row?.sessionId ?? raw?.id ?? '')
          if (!id || hiddenIds.has(id)) return []
          return [{
            ...(raw && typeof raw === 'object' ? raw : {}),
            id,
            ...(typeof row?.cwd === 'string' ? { cwd: row.cwd } : {}),
            ...(typeof row?.projections?.values?.title === 'string' ? { title: row.projections.values.title } : {}),
          }]
        })
        if (restored && !hiddenIds.has(String(restored.sessionId)) && !headers.some((header) => header.id === restored.sessionId)) {
          headers.push({
            id: restored.sessionId,
            ...(restored.workspacePath ? { cwd: restored.workspacePath } : {}),
            ...(restored.title ? { title: restored.title } : {}),
            ...(restored.createdAt === null ? {} : { createdAt: restored.createdAt }),
            ...(restored.updatedAt === null ? {} : { updatedAt: restored.updatedAt }),
            ...(restored.parentSessionId ? { parentSession: restored.parentSessionId } : {}),
            ...(restored.origin ? { origin: restored.origin } : {}),
          })
        }
        await reg.replaceHeaderIndex(headers)
      }
      if (reg && typeof reg.rebuildEntities === 'function') reg.rebuildEntities()
    } catch (e) {}
  }

  let wsByPath = {}

  async function resolveOne(id, suppliedHeader = null, suppliedRow = null) {
    const header = suppliedHeader || await persistedHeader(id)
    const projectedTitle = suppliedRow?.projections?.values?.title
    let title = (typeof projectedTitle === 'string' && projectedTitle.trim() ? projectedTitle.trim() : null) ||
      headerTitle(header) || authorityTitleCache.get(String(id)) || null
    let createdAt = headerField(header, 'createdAt') || suppliedRow?.createdAt || null
    let cwd = typeof suppliedRow?.cwd === 'string' ? suppliedRow.cwd : headerWorkspace(header)
    const ws = cwd ? wsByPath[cwd] : undefined
    const workspaceGone = !!(cwd && !ws)
    const display = title ? (String(title).length > MAX_TITLE ? String(title).slice(0, MAX_TITLE) + '…' : String(title)) : null
    return {
      sessionId: id,
      title: display,
      createdAt: createdAt || null,
      updatedAt: typeof suppliedRow?.updatedAt === 'number' ? suppliedRow.updatedAt : createdAt || null,
      workspacePath: cwd || null,
      workspaceTitle: (ws && ws.title) ? ws.title : null,
      workspaceGone: workspaceGone ? true : false,
      hasWorkspace: !!cwd,
      ...(typeof headerField(header, 'parentSession') === 'string' ? { parentSessionId: headerField(header, 'parentSession') } : {}),
      ...(headerField(header, 'origin') === 'subagent' ? { origin: 'subagent' } : {}),
    }
  }

  async function removeProjectionCache(sid) {
    try {
      const domain = storageDomain.get('session_projcache')
      const table = domain && domain.table && domain.table('sessions')
      if (table && typeof table.delete === 'function') await table.delete(sid)
    } catch (e) {}
  }

  async function moveActiveToCold(kind, sid, wasArchived = false) {
    requireSessionId(sid)
    const header = await persistedHeader(sid)
    if (!header) {
      const error = new Error('找不到该会话')
      error.status = 404
      throw error
    }
    const located = await sessionLocation(header)
    if (!located) throw new Error('找不到该会话的日志路径')
    await detachBeforeMove(sid)
    const sourceDirectory = dirname(located)
    let sizeBytes = null
    try { sizeBytes = (await stat(located)).size } catch (e) {}
    const record = await COLD_STORE.move(kind, sourceDirectory, {
      sessionId: sid,
      title: headerTitle(header),
      workspacePath: headerWorkspace(header),
      createdAt: Number(headerField(header, 'createdAt')) || null,
      updatedAt: Number(headerField(header, 'updatedAt')) || null,
      sizeBytes,
      originalRelativePath: relative(join(DSH_HOME, 'sessions'), sourceDirectory),
      ...(typeof headerField(header, 'parentSession') === 'string'
        ? { parentSessionId: headerField(header, 'parentSession') }
        : {}),
      ...(headerField(header, 'origin') === 'subagent' ? { origin: 'subagent' } : {}),
      ...(wasArchived ? { wasArchived: true } : {}),
    })
    await removeProjectionCache(sid)
    invalidateLightRows()
    await reindexAfterColdMove()
    return { ok: true, [kind === 'archive' ? 'archived' : 'trashed']: true, record }
  }

  async function migrateLegacyArchive(): Promise<void> {
    let domain
    try { domain = dom() } catch { return }
    if (!domain?.global) return
    const state = domain.global.get()
    const legacyIds = Array.isArray(state?.archivedSessionIds)
      ? state.archivedSessionIds.map(String).filter(Boolean)
      : []
    if (legacyIds.length === 0) return
    const unresolved = []
    for (const sid of legacyIds) {
      if (await COLD_STORE.find('archive', sid)) continue
      try { await moveActiveToCold('archive', sid, true) }
      catch { unresolved.push(sid) }
    }
    const next = Object.assign({}, state, { archivedSessionIds: unresolved })
    await domain.global.set(next)
    if (w && 'state' in w) { try { w.state = next } catch (e) { /* best-effort */ } }
  }

  async function restoreOne(sid) {
    requireSessionId(sid)
    const record = await COLD_STORE.restore('archive', sid)
    invalidateLightRows()
    await reindexAfterColdMove(record)
    return { ok: true, restored: true, record }
  }

  // ---- Starred sessions (收藏, schema v3) -----------------------------------
  // User marks, kept in the plugin's own index (never touches DSH logs). Stars
  // survive archive & soft-delete — both are reversible — and are dropped only
  // when the session is really gone (purge, or externally removed; the latter
  // is caught by gcStars during list builds).
  const stars = createStarIndex()
  async function gcStars(validIds) {
    try {
      const store = await stars.read()
      const valid = new Set(validIds.map(String))
      const gone = store.starredSessionIds.filter((id) => !valid.has(id))
      if (gone.length) await stars.removeIds(gone)
    } catch (e) { /* best-effort */ }
  }

  async function deleteOne(sid) {
    requireSessionId(sid)
    const trashed = await COLD_STORE.find('trash', sid)
    if (trashed) return { ok: true, trashed: false, record: trashed }
    const archived = await COLD_STORE.find('archive', sid)
    if (archived) {
      const record = await COLD_STORE.transfer('archive', 'trash', sid)
      await removeProjectionCache(sid)
      invalidateLightRows()
      await reindexAfterColdMove()
      return { ok: true, trashed: true, record }
    }
    return moveActiveToCold('trash', sid)
  }

  async function restoreFromTrash(sid) {
    requireSessionId(sid)
    const record = await COLD_STORE.restore('trash', sid)
    invalidateLightRows()
    await reindexAfterColdMove(record)
    return { ok: true, restored: true, record }
  }

  async function purgeFromTrash(sid) {
    requireSessionId(sid)
    const record = await COLD_STORE.purge('trash', sid)
    await removeProjectionCache(sid)
    invalidateLightRows()
    await reindexAfterColdMove()
    stars.removeIds([sid]).catch(() => {})
    return { ok: true, purged: true, record }
  }

  async function trashSettings(next) {
    if (next === undefined) return COLD_STORE.settings('trash')
    const days = Number(next.retentionDays)
    if (!Number.isInteger(days) || ![0, 7, 30, 90].includes(days)) {
      const error = new Error('retentionDays 仅支持 0、7、30、90')
      error.status = 400
      throw error
    }
    return COLD_STORE.setSettings('trash', { retentionDays: days })
  }

  async function cleanupExpiredTrash() {
    const days = (await COLD_STORE.settings('trash')).retentionDays
    if (!days) return 0
    const cutoff = Date.now() - days * 86400000
    const ids = (await COLD_STORE.list('trash')).filter((item) => item.movedAt > 0 && item.movedAt < cutoff).map((item) => String(item.sessionId))
    let count = 0
    for (const sid of ids) { try { await purgeFromTrash(sid); count++ } catch (e) {} }
    return count
  }

  // ---- "move conversation between workspaces" helper -----------------------
  // DSH binds a conversation to the workspace whose canonical directory path
  // equals the session's stored cwd. Moving it therefore means: (1) adopt the
  // target path as a workspace (create if needed), (2) durably relocate the
  // session's log so its header carries the new cwd, and (3) reassign the
  // workspace membership (detach everywhere, attach to target). The log
  // relocation goes through the persistence service's own encoder (handles the
  // zstd artifact encoding) with a backup + rollback so a failure never leaves
  // the session half-moved.

  async function moveTargetWorkspace(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('缺少目标工作区路径')
    let p = String(rawPath).trim()
    if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
    if (!isAbsolute(p)) p = join(homedir(), p)
    let canonical = null
    try { canonical = await realpath(p) } catch (e) { canonical = null }
    if (canonical === null) {
      await mkdir(p, { recursive: true })
      canonical = await realpath(p)
    }
    return { canonical, entity: await w.create(canonical, basename(canonical) || 'workspace') }
  }

  async function moveOne(sid, targetPath) {
    // Only block the *active* conversation. ctx.sessions keeps instantiated
    // sessions alive after you switch away, so the old check (sessions.get(sid))
    // wrongly rejected every opened session — you could never move one you'd
    // merely looked at. When the host exposes no active-session accessor we
    // can't prove activeness, so we allow the move; the relocation below is
    // crash-safe (backup + rollback) and re-syncs the live object.
    const activeId = getActiveSessionId(ctx)
    if (activeId != null && String(activeId) === String(sid)) {
      throw new Error('该会话当前处于打开状态，请先切换到别的会话再移动。')
    }
    const r = await readStoredSession(sid)
    if (!r || !r.meta) throw new Error('无法读取该会话的日志')
    const meta = r.meta
    const events = r.events
    const oldCwd = meta.cwd || null

    const { canonical, entity: target } = await moveTargetWorkspace(targetPath)

    if (oldCwd) {
      let oldCanon = null
      try { oldCanon = await realpath(oldCwd) } catch (e) { oldCanon = null }
      if (oldCanon === canonical) {
        return { ok: true, already: true, workspaceId: target.id, workspaceTitle: target.title }
      }
    }

    const newHeader = Object.assign({}, meta, { cwd: canonical })

    // 1) Decide relocation strategy. `sessionPersistence.create()` rejects
    // ("already exists in this backend") for ANY session the host has
    // instantiated into its in-memory `states` — and DSH instantiates *every*
    // session it can find on disk at startup, including ARCHIVED ones. So a
    // supposedly "closed" archived session is NOT safe for the create()+append()
    // path; create() will throw. The only universally safe move is to physically
    // relocate the on-disk log (rewriting frame0's cwd) and redirect the live
    // object + persistence state. We still attempt create()+append() as the
    // fast path for genuinely-virgin session ids, but on an already-exists
    // collision we fall back to the relocate path. That covers live, archived,
    // and restored sessions alike.
    const live = ctx.get('sessions')
    const liveObj = live && live.get && live.get(sid)
    const isOpen = !!liveObj

    const ALREADY_EXISTS_RE = /already exists in this backend/i

    // Physically relocate a session's on-disk log to `newHeader`'s cwd,
    // rewriting frame0's cwd so sp.list()/reindex attribute it correctly.
    // Returns true if a relocation actually happened.
    const relocateLog = async (header, newHeaderObj) => {
      const oldPath = locatePath(header)
      const newPath = locatePath(newHeaderObj)
      if (!oldPath || !newPath || oldPath === newPath) return false
      const backupPath = `${oldPath}.move-backup-${Date.now()}`
      try {
        // Ensure the destination project directory exists (rename does not
        // create it). Without this, the rename silently no-ops on ENOENT and
        // the log stays put while workspace.json is wrongly updated.
        await mkdir(dirname(newPath), { recursive: true })
        await rename(oldPath, backupPath)             // current log to safety
        await rewriteFrame0Cwd(backupPath, canonical) // frame0 cwd -> newPath
        await rename(backupPath, newPath)             // relocate to the new workspace dir
      } catch (e) {
        try { await rename(backupPath, oldPath) } catch (_) {}
        if (e && e.code !== 'ENOENT') throw e
        return false
      }
      return true
    }

    const locatePath = (header) => {
      let fn = null
      try { if (typeof sp.locate === 'function') fn = sp.locate.bind(sp) } catch (e) {}
      if (!fn && sp.backend && typeof sp.backend.locate === 'function') fn = sp.backend.locate.bind(sp.backend)
      if (!fn) return null
      try {
        const loc = fn(header)
        if (loc && typeof loc.path === 'string') return loc.path
        if (typeof loc === 'string') return loc
      } catch (e) {}
      return null
    }

    // Rewriting frame0's cwd now lives in src/zstd-frame.js so it can be
    // regression-tested directly. See that module for why frame boundaries are
    // validated by decompression and why a non-session frame0 is rejected
    // instead of rewritten.

    if (isOpen) {
      // Live session: relocate the on-disk log (rewriting frame0's cwd to the
      // new path) and redirect the live object + persistence state. We must
      // rewrite frame0, not just rename: sp.list() reads frame0's cwd from
      // disk, and WorkspaceEntity.sessionIds filters by that exact cwd. A bare
      // rename would leave frame0 pointing at the old workspace, so reindex /
      // restart would keep attributing the session to the wrong workspace.
      await relocateLog(meta, newHeader)
      // Redirect the persistence state's cwd so future appends land in newPath.
      try {
        const st = sp.states && sp.states.get && sp.states.get(sid)
        if (st && st.meta) st.meta = Object.assign({}, st.meta, { cwd: canonical })
      } catch (e) { /* best-effort */ }
    } else {
      // Closed session: try the fast create()+append() path first. But DSH
      // instantiates *all* on-disk sessions (including archived ones) into its
      // in-memory states at startup, so create() usually throws
      // "already exists in this backend". On that collision we fall back to a
      // physical relocate of the existing log (rewriting frame0's cwd), which
      // is safe and needs no create().
      let oldPath = null
      try {
        const loc = locatePath(meta)
        if (loc && typeof loc === 'string') oldPath = loc
        else if (loc && loc.path) oldPath = loc.path
      } catch (e) { oldPath = null }

      if (typeof sp.create !== 'function' || typeof sp.append !== 'function') {
        // No create primitive: must relocate the existing log directly.
        await relocateLog(meta, newHeader)
      } else {
        const backupPath = oldPath ? `${oldPath}.move-backup-${Date.now()}` : null
        if (backupPath) { try { await rename(oldPath, backupPath) } catch (e) { if (e && e.code !== 'ENOENT') throw new Error('移动失败：无法备份旧的会话日志') } }
        const restore = async () => { if (backupPath) { try { await rename(backupPath, oldPath) } catch (_) {} } }
        try {
          await sp.create(newHeader)
          await sp.append(sid, events)
          const check = await sp.readFrom(sid, 0)
          if (!check || !check.meta || check.meta.cwd !== canonical) {
            throw new Error('移动后校验失败：会话工作目录未正确更新')
          }
          if (backupPath) { try { await unlink(backupPath) } catch (e) {} }
        } catch (e) {
          if (ALREADY_EXISTS_RE.test(String((e && e.message) || e))) {
            // Collision: the session is already materialized in states (archived
            // or previously opened). Fall back to physically relocating the log.
            await restore()
            await relocateLog(meta, newHeader)
          } else {
            await restore()
            throw new Error('移动会话日志失败：' + String((e && e.message) || e))
          }
        }
      }
    }

    // Keep the live (in-memory) session object consistent with the relocated
    // log so the host doesn't keep appending to the old path. This MUST happen
    // before attachSession(): WorkspaceEntity.attachSession() validates the
    // session by reading live.header first, and if it still carries the old cwd
    // the realpath check will fail on the old (now missing) directory.
    try {
      if (liveObj) {
        if ('header' in liveObj) liveObj.header = newHeader
        if ('cwd' in liveObj) liveObj.cwd = canonical
        if ('meta' in liveObj) liveObj.meta = newHeader
      }
    } catch (e) { /* best-effort */ }

    // 2) Reassign workspace membership (durable records + in-memory index).
    for (const ent of w.list()) {
      try { await ent.detachSession(sid) } catch (e) { /* ignore */ }
    }
    if (w.headers && typeof w.headers.set === 'function') w.headers.set(sid, newHeader)
    if (w.sessionPaths && typeof w.sessionPaths.set === 'function') w.sessionPaths.set(sid, canonical)
    await target.attachSession(sid)

    // Verify the membership actually landed on the target workspace. DSH's
    // WorkspaceEntity.attachSession persists asynchronously; if it silently
    // no-ops (e.g. the session's durable cwd still points elsewhere) the UI
    // would show "moved" while the sidebar keeps the old grouping. Fail loud
    // instead of returning a fake success.
    const verified = (() => {
      try { return target.sessionIds.includes(sid) } catch (e) { return false }
    })()
    if (!verified) {
      throw new Error('移动后校验失败：会话未出现在目标工作区，请重试或重启 DSH。')
    }

    return {
      ok: true,
      moved: true,
      workspaceId: target.id,
      workspaceTitle: target.title,
      workspacePath: canonical,
    }
  }

  // Force the host's WorkspaceRegistry to rebuild its in-memory sessionPath
  // index from the durable persistence headers. DSH's WorkspaceEntity.sessionIds
  // is a *getter* that filters record.sessionIds by `host.sessionPath(id) ===
  // record.path`; that sessionPath Map is only repopulated at startup (bootstrap
  // + indexHeaders). So even after a successful move writes the durable cwd,
  // the running process keeps attributing the session to its OLD workspace until
  // a restart — unless we reindex here. Calling this right after move makes the
  // sidebar reflect the new grouping with NO restart required.
  async function reindexRegistry() {
    const reg = w
    if (!reg || typeof reg.replaceHeaderIndex !== 'function') return false
    let headers = null
    try {
      const rows = await lightSessionRows()
      headers = rows.flatMap((row) => {
        const raw = row?.header && typeof row.header === 'object' ? row.header : row
        const id = String(row?.sessionId ?? raw?.id ?? '')
        if (!id) return []
        return [{
          ...(raw && typeof raw === 'object' ? raw : {}),
          id,
          ...(typeof row?.cwd === 'string' ? { cwd: row.cwd } : {}),
        }]
      })
    } catch (e) { headers = null }
    if (!headers || !Array.isArray(headers)) return false
    await reg.replaceHeaderIndex(headers)
    if (typeof reg.rebuildEntities === 'function') reg.rebuildEntities()
    return true
  }

  async function listWorkspaces() {
    const out = []
    try {
      for (const ent of w.list()) out.push({ workspaceId: ent.id, title: ent.title, path: ent.path })
    } catch (e) { /* ignore */ }
    return out
  }

  // Archive (hide) one session: adds its id to the durable archive set so it
  // is dropped out of the sidebar. DSH requires the session to exist (live or
  // persisted) — a genuine miss surfaces as an error.
  async function archiveOne(sid) {
    requireSessionId(sid)
    if (await COLD_STORE.find('archive', sid)) return { ok: true, archived: false }
    const trashed = await COLD_STORE.find('trash', sid)
    if (trashed) {
      const record = await COLD_STORE.transfer('trash', 'archive', sid)
      invalidateLightRows()
      await reindexAfterColdMove()
      return { ok: true, archived: true, transferred: true, record }
    }
    return moveActiveToCold('archive', sid)
  }

  async function renameOne(sid, title) {
    requireSessionId(sid)
    if (typeof title !== 'string' || !title.trim()) {
      const error = new Error('会话名称不能为空')
      error.status = 400
      throw error
    }
    if (await COLD_STORE.find('archive', sid) || await COLD_STORE.find('trash', sid)) {
      const error = new Error('冷存会话请先恢复后再重命名')
      error.status = 409
      throw error
    }
    if (!sessionController || typeof sessionController.rename !== 'function') {
      throw new Error('当前 DSH 未提供会话重命名服务')
    }
    const result = await sessionController.rename({ sessionId: sid, title: title.trim() })
    invalidateLightRows()
    authorityTitleCache.set(sid, typeof result?.title === 'string' ? result.title : title.trim())
    return { ok: true, title: authorityTitleCache.get(sid) }
  }

  async function allSessionItems() {
    const rows = await lightSessionRows()
    const archiveItems = await COLD_STORE.list('archive')
    const trashItems = await COLD_STORE.list('trash')
    const hiddenIds = new Set([...archiveItems.map((item) => item.sessionId), ...trashItems.map((item) => item.sessionId)])
    wsByPath = {}
    try { for (const ent of w.list()) wsByPath[ent.path] = ent } catch (e) { wsByPath = {} }
    const items = []
    for (const row of rows) {
      const id = String(row.sessionId ?? row.header?.id ?? '')
      if (!id || hiddenIds.has(id)) continue
      const header = row.header && typeof row.header === 'object' ? row.header : row
      items.push({ ...(await resolveOne(id, header, row)), archived: false })
    }
    // Annotate stars; GC only when we have a trustworthy id baseline, so a
    // failing sp.list() can never wipe the whole index.
    let starredSet = new Set()
    try { starredSet = new Set((await stars.read()).starredSessionIds) } catch (e) {}
    for (const it of items) it.starred = starredSet.has(String(it.sessionId))
    const validIds = [...rows.map((row) => String(row.sessionId ?? row.header?.id ?? '')), ...archiveItems.map((item) => item.sessionId), ...trashItems.map((item) => item.sessionId)]
    if (rows.length > 0) await gcStars(validIds)
    return items
  }

  async function sidebarAuthority() {
    const rows = await lightSessionRows()
    const trashItems = await COLD_STORE.list('trash')
    const archiveItems = await COLD_STORE.list('archive')
    for (const row of rows) {
      const sid = String(row?.sessionId ?? row?.header?.id ?? '')
      const title = row?.projections?.values?.title
      if (sid && typeof title === 'string' && title.trim()) authorityTitleCache.set(sid, title.trim())
    }
    for (const item of [...archiveItems, ...trashItems]) {
      if (item.title) authorityTitleCache.set(String(item.sessionId), item.title)
    }
    authorityTitlesLoaded = true
    return {
      titles: Object.fromEntries(authorityTitleCache),
      trashedSessionIds: trashItems.map((item) => String(item.sessionId)),
      archivedSessionIds: archiveItems.map((item) => String(item.sessionId)),
      purgedSessionIds: [],
    }
  }

  async function coldLogPath(kind, record) {
    const directory = COLD_STORE.pathFor(kind, record)
    const entries = await readdir(directory, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isFile() && /\.jsonl(?:\.zstd)?$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => {
        const version = (name) => Number(name.match(/\.v(\d+)\.jsonl/i)?.[1] ?? 0)
        return version(right) - version(left) || Number(right.endsWith('.zstd')) - Number(left.endsWith('.zstd'))
      })
    if (!candidates[0]) throw new Error('冷存会话日志文件不存在')
    return join(directory, candidates[0])
  }

  async function readSessionForDetails(sid) {
    const archive = await COLD_STORE.find('archive', sid)
    const trash = archive ? undefined : await COLD_STORE.find('trash', sid)
    const coldKind = archive ? 'archive' : trash ? 'trash' : undefined
    const coldRecord = archive ?? trash
    if (coldKind && coldRecord) {
      const filePath = await coldLogPath(coldKind, coldRecord)
      const decoded = readSessionLogFile(filePath)
      return { meta: decoded.meta, events: decoded.events, sizeBytes: coldRecord.sizeBytes }
    }
    const sessions = ctx.get('sessions')
    const live = sessions && sessions.get(sid)
    if (live !== undefined) {
      const events = typeof live.snapshotEvents === 'function'
        ? [...live.snapshotEvents()]
        : Array.isArray(live.events) ? [...live.events] : []
      return { meta: live.header || null, events, sizeBytes: null }
    }
    const r = await readStoredSession(sid)
    if (!r || !r.meta) throw new Error('找不到该会话的记录（会话不存在）')
    return { meta: r.meta, events: Array.isArray(r.events) ? r.events : [], sizeBytes: null }
  }

  // 聚合一条会话的详情（磁盘占用 / 轮次·步数·消息数 / 工具统计 / fetch /
  // write/edit 文件 / 血统 parent/children/subagents）。live 与冷存会话都可读。
  // 详情是显式按需操作；列表和启动路径不会调用本函数。
  async function buildDetails(sid) {
    requireSessionId(sid)
    const sessions = ctx.get('sessions')
    const loaded = await readSessionForDetails(sid)
    const meta = loaded.meta || {}
    const events = loaded.events
    let sizeBytes = loaded.sizeBytes
    try {
      if (sizeBytes === null) {
        const loc = sp.locate(meta)
        if (loc && typeof loc.path === 'string' && loc.path) {
          const st = await stat(loc.path)
          if (st && typeof st.size === 'number') sizeBytes = st.size
        }
      }
    } catch (e) { sizeBytes = null }
    let lastTime = typeof meta.createdAt === 'number' ? meta.createdAt : 0
    const fileSet = new Map()
    const stats = {
      turns: 0, steps: 0, userMessages: 0, assistantMessages: 0,
      toolCalls: 0, attachments: 0, toolCounts: {}, fetches: [],
    }
    const turnSeen = new Set()
    const stepSeen = new Set()
    for (const ev of events) {
      if (ev && typeof ev.time === 'number' && ev.time > lastTime) lastTime = ev.time
      const d = (ev && ev.data && typeof ev.data === 'object') ? ev.data : {}
      const type = ev && ev.type
      switch (type) {
        case 'turn/start':
          if (typeof d.turn === 'number') turnSeen.add(d.turn)
          break
        case 'step/start':
          if (typeof d.step === 'number') stepSeen.add(d.step)
          break
        case 'user/message':
          stats.userMessages++
          if (Array.isArray(d.content)) for (const b of d.content) if (b && b.type === 'image') stats.attachments++
          break
        case 'assistant/message':
          stats.assistantMessages++
          break
        case 'tool/call': {
          stats.toolCalls++
          const tn = typeof d.name === 'string' && d.name ? d.name : 'tool'
          stats.toolCounts[tn] = (stats.toolCounts[tn] || 0) + 1
          if (FETCH_TOOL_RE.test(tn)) {
            let query
            try {
              const a = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments
              query = typeof a?.query === 'string' ? a.query : typeof a?.url === 'string' ? a.url : typeof a?.q === 'string' ? a.q : undefined
            } catch (e) { query = undefined }
            stats.fetches.push({ tool: tn, ...(query && query !== '' ? { query } : {}) })
          }
          if (tn === 'write' || tn === 'edit') {
            let argsJ
            try { argsJ = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments } catch (e) { break }
            const fp = argsJ && typeof argsJ.file_path === 'string' && argsJ.file_path ? argsJ.file_path : undefined
            if (fp !== undefined && !fileSet.has(fp)) fileSet.set(fp, tn)
          }
          break
        }
      }
    }
    stats.turns = turnSeen.size
    stats.steps = stepSeen.size
    if (stats.fetches.length > MAX_FETCHES) stats.fetches = stats.fetches.slice(0, MAX_FETCHES)
    const fileEntries = [...fileSet.entries()].slice(0, MAX_FILES * 2)
    const exists = await Promise.all(fileEntries.map(([p]) => stat(p).then(() => true).catch(() => false)))
    const files = fileEntries
      .filter((_, i) => exists[i])
      .map(([path, tool]) => ({ path, tool }))
      .slice(0, MAX_FILES)
    // lineage：分叉子会话（非 subagent）与子代理（origin==='subagent'），source 去重。
    const lineage = {
      parentSessionId: (meta && typeof meta.parentSession === 'string') ? meta.parentSession : null,
      children: [],
      subagents: [],
    }
    const childrenSet = new Set()
    const subagentSet = new Set()
    try {
      for (const row of await lightSessionRows()) {
        const childId = String(row?.sessionId ?? row?.header?.id ?? '')
        const parentId = row?.parentSessionId ?? row?.header?.parentSession
        if (!childId || String(parentId ?? '') !== String(sid)) continue
        if (row?.origin === 'subagent' || row?.header?.origin === 'subagent') subagentSet.add(childId)
        else childrenSet.add(childId)
      }
      for (const item of [...await COLD_STORE.list('archive'), ...await COLD_STORE.list('trash')]) {
        if (String(item.parentSessionId ?? '') !== String(sid)) continue
        if (item.origin === 'subagent') subagentSet.add(item.sessionId); else childrenSet.add(item.sessionId)
      }
    } catch (e) { /* best-effort */ }
    if (sessions) {
      try {
        sessions.list().forEach((s) => {
          if (String(s.header.parentSession) !== String(sid)) return
          if (s.header.origin === 'subagent') subagentSet.add(s.id); else childrenSet.add(s.id)
        })
      } catch (e) { /* best-effort */ }
    }
    lineage.children = [...childrenSet]
    lineage.subagents = [...subagentSet]
    return {
      sessionId: sid,
      sizeBytes,
      createdAt: (meta && typeof meta.createdAt === 'number') ? meta.createdAt : null,
      updatedAt: lastTime || null,
      files,
      stats,
      lineage,
    }
  }

  const sessionCore: SessionCore = {
    listActive: allSessionItems,
    listArchive: () => COLD_STORE.list('archive'),
    listTrash: async () => {
      await cleanupExpiredTrash()
      return COLD_STORE.list('trash')
    },
    archive: archiveOne,
    restore: restoreOne,
    delete: deleteOne,
    restoreTrash: restoreFromTrash,
    purge: purgeFromTrash,
    rename: async (sid, title) => (await renameOne(sid, title)).title,
    readEvents: async (sid, fromSeq = 0) => {
      const value = await readSessionForDetails(sid)
      return (value.events || []).filter((event) => typeof event?.seq !== 'number' || event.seq >= fromSeq)
    },
    readDetails: buildDetails,
    readExport: async (sid) => {
      const value = await readSessionForDetails(sid)
      if (!value.meta) throw new Error('无法读取该会话的日志')
      return renderSessionMarkdown({ ...value.meta, id: sid }, value.events || [])
    },
    coldRecord: (kind, sid) => COLD_STORE.find(kind, sid),
  }
  const unregisterCore = registerSessionCore(sessionCore)
  void lightSessionRows().catch(() => undefined)

  ctx.effect(() => {
    const disposers = []
    if (typeof ctx.provide === 'function') {
      try { disposers.push(ctx.provide('dshSessionCore', sessionCore)) } catch (e) { /* registry fallback remains active */ }
    }
    disposers.push(unregisterCore)
    void migrateLegacyArchive().catch(() => undefined)

    if (typeof ctx.on === 'function') disposers.push(ctx.on('session/created', () => {
      invalidateLightRows()
    }))
    if (typeof ctx.on === 'function') disposers.push(ctx.on('session/event', (session, event) => {
      if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
        authorityTitleCache.set(String(session.id), event.data.title)
        invalidateLightRows()
      }
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/list',
      handler: async (req, res) => {
        try {
          const items = await COLD_STORE.list('archive')
          json(res, { items })
        } catch (e) {
          json(res, { error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/restore',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, await restoreOne(sid))
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/restore-many',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const ids = parseIds(body)
          if (!ids || ids.length === 0) return json(res, { ok: false, error: 'missing sessionIds' }, 400)
          const results = []
          for (const sid of ids) {
            try { results.push({ sessionId: sid, ok: true, ...(await restoreOne(sid)) }) }
            catch (e) { results.push({ sessionId: sid, ok: false, error: String((e && e.message) || e) }) }
          }
          json(res, { ok: true, restored: results.filter((r) => r.ok).length, results })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/delete',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, await deleteOne(sid))
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/delete-many',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const ids = parseIds(body)
          if (!ids || ids.length === 0) return json(res, { ok: false, error: 'missing sessionIds' }, 400)
          const results = []
          for (const sid of ids) {
            try { results.push({ sessionId: sid, ok: true, ...(await deleteOne(sid)) }) }
            catch (e) { results.push({ sessionId: sid, ok: false, error: String((e && e.message) || e) }) }
          }
          json(res, { ok: true, deleted: results.filter((r) => r.ok).length, results })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    // ---- Recycle bin (回收站) routes ----------------------------------------
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/trash/list',
      handler: async (req, res) => {
        try {
          await cleanupExpiredTrash()
          const list = await COLD_STORE.list('trash')
          json(res, { schemaVersion: 1, settings: await COLD_STORE.settings('trash'), purgedSessionIds: [], items: list })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/trash/settings',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const settings = body && Object.prototype.hasOwnProperty.call(body, 'retentionDays')
            ? await trashSettings({ retentionDays: body.retentionDays })
            : await trashSettings()
          json(res, { ok: true, settings })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/trash/verify',
      handler: async (req, res) => {
        try {
          const items = await COLD_STORE.list('trash')
          const results = await Promise.all(items.map(async (item) => {
            let exists = false
            const target = join(COLD_STORE.trashRoot, item.storedRelativePath)
            exists = await stat(target).then((value) => value.isDirectory()).catch(() => false)
            return { sessionId: item.sessionId, status: exists ? 'ok' : 'missing', originalRelativePath: item.originalRelativePath }
          }))
          json(res, { ok: true, healthy: results.filter((r) => r.status === 'ok').length, missing: results.filter((r) => r.status === 'missing').length, results })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/trash/restore',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, await restoreFromTrash(sid))
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/trash/archive',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, await archiveOne(sid))
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/trash/archive-many',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const ids = parseIds(body)
          if (!ids || ids.length === 0) return json(res, { ok: false, error: 'missing sessionIds' }, 400)
          const results = []
          for (const sid of ids) {
            try { results.push({ sessionId: sid, ok: true, ...(await archiveOne(sid)) }) }
            catch (e) { results.push({ sessionId: sid, ok: false, error: String((e && e.message) || e) }) }
          }
          json(res, { ok: true, archived: results.filter((r) => r.ok).length, results })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/trash/purge',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, await purgeFromTrash(sid))
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/trash/purge-many',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const ids = parseIds(body)
          if (!ids || ids.length === 0) return json(res, { ok: false, error: 'missing sessionIds' }, 400)
          const results = []
          for (const sid of ids) {
            try { results.push({ sessionId: sid, ok: true, ...(await purgeFromTrash(sid)) }) }
            catch (e) { results.push({ sessionId: sid, ok: false, error: String((e && e.message) || e) }) }
          }
          json(res, { ok: true, purged: results.filter((r) => r.ok).length, results })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    // All conversations (for the "移动会话" panel).
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/sessions',
      handler: async (req, res) => {
        try {
          json(res, { items: await allSessionItems() })
        } catch (e) {
          json(res, { error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    // Star / unstar one or many sessions (收藏, schema v3).
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/star/set',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const starred = !!(body && body.starred)
          let ids = parseIds(body)
          if ((!ids || ids.length === 0) && body && typeof body.sessionId === 'string') {
            ids = isSafeSessionId(body.sessionId) ? [body.sessionId] : null
          }
          if (!ids || ids.length === 0) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          const starredSessionIds = await stars.setStarred(ids, starred)
          json(res, { ok: true, starredSessionIds })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/rename',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, { sessionId: sid, ...(await renameOne(sid, body.title)) })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    // Human-readable Markdown export (one session). Raw-log ZIP export is
    // dsh's own GET /api/session.export — we deliberately do not duplicate it
    // (see reports/HANDOFF-dsh-sessions-manager-roadmap.md §2.4).
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/export-md',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const sid = url.searchParams.get('sessionId')
          requireSessionId(sid)
          const r = await readSessionForDetails(sid)
          if (!r.meta) {
            const error = new Error('无法读取该会话的日志')
            error.status = 404
            throw error
          }
          const md = renderSessionMarkdown({ ...r.meta, id: sid }, r.events || [])
          res.writeHead(200, {
            'content-type': 'text/markdown; charset=utf-8',
            'content-disposition': `attachment; filename="dsh-session-${sid}.md"`,
            'cache-control': 'no-store',
          })
          res.end(md)
        } catch (e) {
          json(res, { error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/sidebar-state',
      handler: async (req, res) => {
        try {
          json(res, await sidebarAuthority())
        } catch (e) {
          json(res, { error: String((e && e.message) || e) }, errorStatus(e))
        }
      },
    }))

    // Available target workspaces (for the move picker).
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/workspaces',
      handler: async (req, res) => {
        try {
          json(res, { items: await listWorkspaces() })
        } catch (e) {
          json(res, { error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    // Move one conversation to a target workspace (existing path or a new one).
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/move',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          const target = body && typeof body.targetPath === 'string' ? body.targetPath : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          if (!target) return json(res, { ok: false, error: 'missing targetPath' }, 400)
          const moved = await moveOne(sid, target)
          // Reindex the host's in-memory sessionPath index so the sidebar
          // reflects the new grouping immediately (no DSH restart needed).
          // Do this before replying: drag/drop and menu clients treat a 2xx
          // response as the commit point and must never announce success while
          // the sidebar still holds the old workspace index.
          try { await reindexRegistry() } catch (e) { /* best-effort */ }
          json(res, { sessionId: sid, ...moved })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    // Archive (hide) one session.
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/archive',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, { sessionId: sid, ...(await archiveOne(sid)) })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    // Archive (hide) many sessions.
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/archive-many',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const ids = parseIds(body)
          if (!ids || ids.length === 0) return json(res, { ok: false, error: 'missing sessionIds' }, 400)
          const results = []
          for (const sid of ids) {
            try { results.push({ sessionId: sid, ok: true, ...(await archiveOne(sid)) }) }
            catch (e) { results.push({ sessionId: sid, ok: false, error: String((e && e.message) || e) }) }
          }
          json(res, { ok: true, archived: results.filter((r) => r.ok).length, results })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, 500)
        }
      },
    }))

    // Per-session details (v2.0): disk usage, turn/step/message counts, tool
    // usage, fetch records, write/edit files, and lineage.
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/archived-sessions/details',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, await buildDetails(sid))
        } catch (e) {
          json(res, { error: String((e && e.message) || e) }, (e && e.status) ? e.status : 500)
        }
      },
    }))

    // Compatibility endpoint for the Feishu web adapter: normal deletion is
    // recoverable and therefore only moves the session into the recycle bin.
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/__chameleon/session/delete',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          json(res, { sessionId: sid, ...(await deleteOne(sid)) })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, (e && e.status) ? e.status : 500)
        }
      },
    }))

    // Direct permanent deletion for the Feishu /purge command. The session is
    // first recorded in the recycle bin so purgeFromTrash can apply its
    // durable tombstone and path-safety checks in one operation.
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/__chameleon/session/purge',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sid = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (!sid) return json(res, { ok: false, error: 'missing sessionId' }, 400)
          await deleteOne(sid)
          json(res, { sessionId: sid, ...(await purgeFromTrash(sid)) })
        } catch (e) {
          json(res, { ok: false, error: String((e && e.message) || e) }, (e && e.status) ? e.status : 500)
        }
      },
    }))
    return () => { for (const d of disposers) d() }
  }, 'dsh-sessions-manager: routes')
}
