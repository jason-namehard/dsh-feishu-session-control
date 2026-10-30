// @ts-nocheck

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { access, readFile, unlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { withFileLock } from '../platform/file-lock.js'
import { writeFileAtomic } from '../platform/atomic-write.js'

export const name = 'dsh-plugin-manager'
export const inject = ['webServer', 'loader']

const PREFIX = '/dsh-plugin-manager'
const MAX_BODY_BYTES = 64 * 1024
const COMMAND_TIMEOUT_MS = 180_000
const OUTPUT_LIMIT = 96 * 1024
const MANAGED_BEGIN = '# dsh-plugin-manager:begin'
const MANAGED_END = '# dsh-plugin-manager:end'
const MANAGER_PACKAGE = 'dsh-lark-bot'
const MANAGER_MODULE = 'dsh-lark-bot/plugin-manager'
const HOT_INSTALLER_PACKAGE = 'dsh-hot-installer'

const PURPOSES = {
  'dsh-lark-bot': '提供飞书/Lark 桥接、会话管理和远程控制。',
  'dsh-hot-installer': '监视 profile 依赖并把插件变更热加载到当前 DSH。',
  '@deepseek-ai/dsh-session': '提供 DSH 会话运行时和会话生命周期。',
  '@deepseek-ai/dsh-session-persistence-jsonl': '把 DSH 会话持久化为 JSONL 日志。',
  '@deepseek-ai/dsh-session-query-sqlite': '为会话列表和查询提供轻量索引。',
  '@deepseek-ai/dsh-session-title': '为新会话生成和维护标题。',
  '@deepseek-ai/dsh-session-projection': '把会话状态投影给 DSH 的其他界面。',
  '@deepseek-ai/dsh-storage': '提供 DSH 的持久化存储抽象。',
  '@deepseek-ai/dsh-web-app': '提供 DSH Web 应用和浏览器入口。',
  '@deepseek-ai/dsh-client-modules': '组合并提供 DSH Web 插件的浏览器模块。',
  '@deepseek-ai/dsh-client-connection': '提供浏览器与 DSH Host 的连接通道。',
  '@deepseek-ai/dsh-client-ui-settings': '提供 DSH Web 设置页基础设施。',
  '@deepseek-ai/dsh-client-ui-settings-plugins': '提供插件设置页和插件配置标签页。',
}

const PROTECTED_ENTRY_IDS = new Set([
  'include',
  'loader',
  'web-server',
  'client-modules',
  'client-connection',
  'ui-settings',
  'ui-settings-plugins',
  'dsh-plugin-manager',
])

const PROTECTED_PACKAGES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  HOT_INSTALLER_PACKAGE,
  MANAGER_PACKAGE,
])

const CORE_MODULE_PREFIXES = [
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-settings',
]

const SEMVER = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?'
const EXACT_SCOPED = new RegExp(`^(@[a-z0-9._~-]+\\/[a-z0-9._~-]+)@(${SEMVER})$`, 'i')
const EXACT_UNSCOPED = new RegExp(`^([a-z0-9._~-]+)@(${SEMVER})$`, 'i')

function json(res, value, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function errorStatus(error) {
  return error && Number.isInteger(error.status) ? error.status : 500
}

function fail(message, status = 400) {
  const error = new Error(message)
  error.status = status
  throw error
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress ?? '').toLowerCase()
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) fail('请求体过大', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fail('请求体必须是 JSON 对象')
  } catch (error) {
    if (error.status) throw error
    fail('请求体不是有效 JSON')
  }
}

function requireString(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}无效`)
  return value.trim()
}

export function parseExactPackageSpec(value) {
  if (typeof value !== 'string') return undefined
  const input = value.trim()
  const match = input.match(EXACT_SCOPED) ?? input.match(EXACT_UNSCOPED)
  if (!match) return undefined
  return { spec: input, packageName: match[1], version: match[2] }
}

export function packageNameFromModule(moduleName) {
  if (typeof moduleName !== 'string' || moduleName.startsWith('cordis:')) return undefined
  if (moduleName.startsWith('@')) {
    const parts = moduleName.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  }
  return moduleName.split('/')[0] || undefined
}

export function purposeForPackage(packageName, manifest = {}) {
  const declared = manifest.dsh?.description?.zh ?? manifest.dshWorkshop?.description?.zh
  if (typeof declared === 'string' && declared.trim()) return declared.trim().replace(/[。.!！?？]+$/u, '') + '。'
  if (typeof PURPOSES[packageName] === 'string') return PURPOSES[packageName]
  return `插件 ${packageName} 的用途由其包声明。`
}

function phaseOf(entry) {
  const state = entry.fiber?.state
  return state === 0 ? 'pending'
    : state === 1 ? 'loading'
      : state === 2 ? 'active'
        : state === 3 ? 'failed'
          : state === 5 ? 'unloading'
            : null
}

function protectedEntry(entry, packageName) {
  const id = String(entry.options?.id ?? '')
  const moduleName = String(entry.options?.name ?? '')
  return PROTECTED_ENTRY_IDS.has(id)
    || PROTECTED_PACKAGES.has(packageName)
    || moduleName === MANAGER_MODULE
    || CORE_MODULE_PREFIXES.some((prefix) => moduleName === prefix || moduleName.startsWith(`${prefix}/`))
}

function packageHasProtectedEntry(loader, packageName) {
  if (PROTECTED_PACKAGES.has(packageName)) return true
  for (const entry of loader?.entries?.() ?? []) {
    if (!entry?.options || entry.options.group || packageNameFromModule(entry.options.name) !== packageName) continue
    if (protectedEntry(entry, packageName)) return true
  }
  return false
}

function profileDirFromLoader(loader) {
  for (const entry of loader?.entries?.() ?? []) {
    if (entry?.options?.name !== 'cordis:include') continue
    const configuredPath = entry.options.config?.path
    if (typeof configuredPath !== 'string') continue
    try {
      return dirname(fileURLToPath(configuredPath))
    } catch {
      return undefined
    }
  }
  return undefined
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readProfileManifest(profileDir) {
  if (!profileDir) fail('无法定位当前 DSH profile', 503)
  try {
    return await readJsonFile(join(profileDir, 'package.json'))
  } catch {
    fail('当前 DSH profile 缺少有效 package.json', 503)
  }
}

const PROFILE_STATE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

async function snapshotProfileState(profileDir) {
  const snapshot = new Map()
  for (const name of PROFILE_STATE_FILES) {
    const path = join(profileDir, name)
    try {
      snapshot.set(name, await readFile(path, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      snapshot.set(name, undefined)
    }
  }
  return snapshot
}

async function restoreProfileState(profileDir, snapshot) {
  for (const name of PROFILE_STATE_FILES) {
    const content = snapshot.get(name)
    const path = join(profileDir, name)
    if (content === undefined) {
      try {
        await writeFileAtomic(path, '')
        await unlink(path)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    } else {
      await writeFileAtomic(path, content)
    }
  }
}

function dependencySpec(manifest, packageName) {
  return manifest.dependencies?.[packageName]
    ?? manifest.devDependencies?.[packageName]
    ?? manifest.optionalDependencies?.[packageName]
}

function bundleNames(manifest) {
  return Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((item) => typeof item === 'string')
    : []
}

function resolvePackageManifest(profileDir, packageName) {
  try {
    const requireFromProfile = createRequire(join(profileDir, 'package.json'))
    try {
      return requireFromProfile.resolve(`${packageName}/package.json`)
    } catch {
      const entry = requireFromProfile.resolve(packageName)
      let current = dirname(entry)
      for (let depth = 0; depth < 8; depth += 1) {
        const candidate = join(current, 'package.json')
        if (existsSync(candidate)) return candidate
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

async function packageInfo(profileDir, packageName) {
  const manifestPath = resolvePackageManifest(profileDir, packageName)
  if (!manifestPath) return undefined
  try {
    const manifest = await readJsonFile(manifestPath)
    return { manifest, manifestPath, packageDir: dirname(manifestPath) }
  } catch {
    return undefined
  }
}

function currentDshVersion(profileDir) {
  try {
    const requireFromProfile = createRequire(join(profileDir, 'package.json'))
    const manifestPath = requireFromProfile.resolve('@deepseek-ai/dsh/package.json')
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version
  } catch {
    return process.env.DSH_VERSION
  }
}

function patchPathFor(packageDir, manifest) {
  const declared = manifest.dsh?.bundle?.patch
  if (typeof declared !== 'string' || !declared.trim() || isAbsolute(declared)) return undefined
  const candidate = resolve(packageDir, declared)
  const root = resolve(packageDir)
  const rel = relative(root, candidate)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return candidate
}

async function validateBundlePackage(profileDir, packageName, expectedVersion) {
  const info = await packageInfo(profileDir, packageName)
  if (!info || info.manifest.name !== packageName || info.manifest.version !== expectedVersion) {
    fail(`未找到已安装的 ${packageName}@${expectedVersion}`, 422)
  }
  const patchPath = patchPathFor(info.packageDir, info.manifest)
  if (!patchPath) fail(`${packageName} 没有安全的 dsh.bundle.patch 声明`, 422)
  try {
    await access(patchPath)
    const document = parseDocument(await readFile(patchPath, 'utf8'))
    if (document.errors.length > 0 || !Array.isArray(document.toJS())) fail(`${packageName} 的 bundle patch 不是有效列表`, 422)
  } catch (error) {
    if (error.status) throw error
    fail(`${packageName} 的 bundle patch 无法读取`, 422)
  }
  const current = currentDshVersion(profileDir)
  const supported = info.manifest.dshWorkshop?.compatibility?.dshVersions
  if (!Array.isArray(supported) || !current || !supported.includes(current)) {
    fail(`${packageName} 未声明兼容当前 DSH ${current ?? '版本未知'} 的版本`, 422)
  }
  return info
}

function managedBlockRange(content) {
  const begin = content.indexOf(MANAGED_BEGIN)
  const end = content.indexOf(MANAGED_END, begin + MANAGED_BEGIN.length)
  if (begin === -1 || end === -1 || end < begin) return undefined
  const endOffset = end + MANAGED_END.length
  const lineEnd = content[endOffset] === '\r' && content[endOffset + 1] === '\n' ? endOffset + 2 : content[endOffset] === '\n' ? endOffset + 1 : endOffset
  const start = content.lastIndexOf('\n', begin) + 1
  return { start, end: lineEnd }
}

export function readManagedDisabledOverrides(content) {
  const range = managedBlockRange(content)
  if (!range) return []
  const body = content.slice(content.indexOf('\n', range.start) + 1, content.indexOf(MANAGED_END, range.start))
  try {
    const parsed = parseDocument(body).toJS()
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string' && item.disabled === true) : []
  } catch {
    return []
  }
}

export function replaceManagedDisabledOverrides(content, overrides) {
  const clean = overrides
    .filter((item) => item && typeof item.id === 'string' && item.disabled === true)
    .map((item) => ({ id: item.id, ...(typeof item.name === 'string' ? { name: item.name } : {}), disabled: true }))
  const range = managedBlockRange(content)
  if (range) {
    if (clean.length === 0) {
      const before = content.slice(0, range.start)
      const after = content.slice(range.end)
      if (before.trim() === '' && after.trim() === '') return '[]\n'
      return `${before}${after}`.replace(/\n{3,}/g, '\n\n')
    }
    const block = `${MANAGED_BEGIN}\n${stringify(clean).trimEnd()}\n${MANAGED_END}\n`
    return content.slice(0, range.start) + block + content.slice(range.end)
  }
  if (clean.length === 0) return content.trim() === '' ? '[]\n' : content
  const block = `${MANAGED_BEGIN}\n${stringify(clean).trimEnd()}\n${MANAGED_END}\n`
  if (content.trim() === '' || content.trim() === '[]') return block
  return `${content.trimEnd()}\n${block}`
}

async function updateManagedDisabled(profileDir, entry, disabled) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  return withFileLock(join(profileDir, '.dsh-plugin-manager.lock'), '插件设置正在被另一个操作使用', async () => {
    let previous = '[]\n'
    try { previous = await readFile(patchPath, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const overrides = readManagedDisabledOverrides(previous)
      .filter((item) => item.id !== entry.options.id)
    if (disabled) overrides.push({ id: entry.options.id, name: entry.options.name, disabled: true })
    const next = replaceManagedDisabledOverrides(previous, overrides)
    await writeFileAtomic(patchPath, next)
    try {
      await entry.update({ disabled }, false, true)
    } catch (error) {
      await writeFileAtomic(patchPath, previous)
      throw error
    }
    return { managed: disabled }
  })
}

function profileLock(profileDir) {
  return join(profileDir, '.dsh-plugin-manager.lock')
}

function runPnpm(profileDir, args) {
  return new Promise((resolvePromise, reject) => {
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const child = spawn(command, args, { cwd: profileDir, shell: false, windowsHide: true })
    const output = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('pnpm 操作超时'))
    }, COMMAND_TIMEOUT_MS)
    const collect = (chunk) => {
      if (size >= OUTPUT_LIMIT) return
      const text = String(chunk)
      size += text.length
      output.push(text.slice(0, OUTPUT_LIMIT - Math.max(0, size - text.length)))
    }
    const finish = (error, code = 1) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error || code !== 0) {
        const detail = output.join('').trim().slice(-4000)
        const failure = error ?? new Error(`pnpm 操作失败（退出码 ${code}）${detail ? `：${detail}` : ''}`)
        reject(failure)
      } else resolvePromise({ output: output.join('') })
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => finish(undefined, code ?? 1))
  })
}

async function listPlugins(ctx, loader, profileDir, manifest) {
  const entries = []
  const cache = new Map()
  const bundles = new Set(bundleNames(manifest))
  let hotInstallerActive = false
  for (const entry of loader?.entries?.() ?? []) {
    if (!entry?.options || entry.options.group || entry.options.name === 'cordis:include') continue
    const moduleName = String(entry.options.name ?? '')
    const packageName = packageNameFromModule(moduleName)
    if (!packageName) continue
    let info = cache.get(packageName)
    if (info === undefined) {
      info = await packageInfo(profileDir, packageName) ?? null
      cache.set(packageName, info)
    }
    if (packageName === HOT_INSTALLER_PACKAGE && !entry.disabled) hotInstallerActive = true
    const protectedRow = protectedEntry(entry, packageName)
    entries.push({
      entryId: entry.id,
      localEntryId: entry.options.id,
      moduleName,
      packageName,
      version: info?.manifest?.version ?? null,
      description: purposeForPackage(packageName, info?.manifest ?? {}),
      enabled: !entry.disabled,
      fiberPhase: phaseOf(entry),
      installedInProfile: bundles.has(packageName),
      protected: protectedRow,
      canDisable: !protectedRow,
      canUninstall: !packageHasProtectedEntry(loader, packageName) && bundles.has(packageName),
      permissions: Array.isArray(info?.manifest?.dshWorkshop?.permissions) ? info.manifest.dshWorkshop.permissions : [],
    })
  }
  return {
    profile: profileDir ? basename(profileDir) : null,
    hotInstallerActive,
    entries,
  }
}

function findEntry(loader, id) {
  try {
    const entry = loader.resolve(id)
    if (!entry?.options || entry.options.group || entry.options.name === 'cordis:include') fail('不能操作该 Loader 节点', 422)
    return entry
  } catch (error) {
    if (error.status) throw error
    fail('找不到指定插件', 404)
  }
}

async function installPackage(profileDir, manifest, spec, confirmRisk) {
  const parsed = parseExactPackageSpec(spec)
  if (!parsed) fail('只允许安装精确的 registry package@version，不接受 latest、范围、git 或 file 路径')
  if (PROTECTED_PACKAGES.has(parsed.packageName)) fail('DSH 核心包不能通过插件管家重复安装或替换', 403)
  const snapshot = await snapshotProfileState(profileDir)
  const before = snapshot.get('package.json')
  if (typeof before !== 'string') fail('当前 DSH profile 缺少 package.json', 503)
  const beforeManifest = JSON.parse(before)
  const wasDependency = dependencySpec(beforeManifest, parsed.packageName) !== undefined
  if (wasDependency) fail(`${parsed.packageName} 已存在，请使用 DSH 的升级流程，不要在这里覆盖版本`)
  try {
    await runPnpm(profileDir, ['add', '--ignore-scripts', '--save-exact', '--reporter=append-only', parsed.spec])
    const installed = await validateBundlePackage(profileDir, parsed.packageName, parsed.version)
    const permissions = installed.manifest.dshWorkshop?.permissions
    const hasPermissions = Array.isArray(permissions) && permissions.length > 0
    const hasExecutablePatch = typeof installed.manifest.dsh?.bundle?.patch === 'string'
      && /!!js\b/u.test(await readFile(patchPathFor(installed.packageDir, installed.manifest), 'utf8'))
    if ((hasPermissions || hasExecutablePatch) && confirmRisk !== true) {
      fail('该插件声明了运行权限或可执行 patch；请在确认后再次安装', 428)
    }
    const bundles = bundleNames(beforeManifest)
    const nextManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const nextBundles = bundleNames(nextManifest)
    if (!nextBundles.includes(parsed.packageName)) nextBundles.push(parsed.packageName)
    nextManifest.dsh = { ...(nextManifest.dsh ?? {}), profile: { ...(nextManifest.dsh?.profile ?? {}), bundles: nextBundles } }
    await writeFileAtomic(join(profileDir, 'package.json'), `${JSON.stringify(nextManifest, null, 2)}\n`)
    return { packageName: parsed.packageName, version: parsed.version, hot: true, previouslyInstalled: wasDependency, previousBundles: bundles }
  } catch (error) {
    if (!wasDependency) {
      try { await runPnpm(profileDir, ['remove', '--ignore-scripts', '--reporter=append-only', parsed.packageName]) } catch { /* preserve original failure */ }
    }
    try { await restoreProfileState(profileDir, snapshot) } catch { /* preserve original failure */ }
    throw error
  }
}

async function uninstallPackage(profileDir, loader, manifest, packageName) {
  requireString(packageName, 'packageName', 200)
  if (packageHasProtectedEntry(loader, packageName)) fail('该包包含 DSH 核心组件，不能卸载', 403)
  const bundles = bundleNames(manifest)
  if (!bundles.includes(packageName)) fail('该包不是当前 profile 的插件', 404)
  const snapshot = await snapshotProfileState(profileDir)
  const before = snapshot.get('package.json')
  if (typeof before !== 'string') fail('当前 DSH profile 缺少 package.json', 503)
  const nextManifest = JSON.parse(before)
  nextManifest.dsh = {
    ...(nextManifest.dsh ?? {}),
    profile: { ...(nextManifest.dsh?.profile ?? {}), bundles: bundles.filter((item) => item !== packageName) },
  }
  await withFileLock(profileLock(profileDir), '插件设置正在被另一个操作使用', async () => {
    await writeFileAtomic(join(profileDir, 'package.json'), `${JSON.stringify(nextManifest, null, 2)}\n`)
    try {
      await runPnpm(profileDir, ['remove', '--ignore-scripts', '--reporter=append-only', packageName])
    } catch (error) {
      await restoreProfileState(profileDir, snapshot)
      throw error
    }
    const current = await readProfileManifest(profileDir)
    const currentBundles = bundleNames(current)
    if (currentBundles.includes(packageName)) {
      current.dsh = { ...(current.dsh ?? {}), profile: { ...(current.dsh?.profile ?? {}), bundles: currentBundles.filter((item) => item !== packageName) } }
      await writeFileAtomic(join(profileDir, 'package.json'), `${JSON.stringify(current, null, 2)}\n`)
    }
  })
  return { packageName, hot: true }
}

function methodHandler(method, handler) {
  return async (req, res) => {
    if (!isLoopbackRequest(req)) return json(res, { ok: false, error: '插件管理只允许本机请求' }, 403)
    if (req.method !== method) {
      res.writeHead(405, { allow: method })
      res.end()
      return
    }
    try {
      const result = await handler(req)
      json(res, { ok: true, ...result })
    } catch (error) {
      json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, errorStatus(error))
    }
  }
}

export function apply(ctx) {
  const loader = ctx.loader ?? ctx.get('loader')
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!loader || !webServer) throw new Error('插件管家缺少 DSH Loader 或 WebServer')
  const profileDir = profileDirFromLoader(loader)
  if (!profileDir) throw new Error('插件管家无法定位当前 DSH profile')

  const routes = []
  routes.push(webServer.register({
    kind: 'exact',
    path: `${PREFIX}/list`,
    handler: methodHandler('GET', async () => ({ ...(await listPlugins(ctx, loader, profileDir, await readProfileManifest(profileDir))) })),
  }))
  routes.push(webServer.register({
    kind: 'exact',
    path: `${PREFIX}/toggle`,
    handler: methodHandler('POST', async (req) => {
      const body = await readJsonBody(req)
      const entry = findEntry(loader, requireString(body.entryId, 'entryId', 300))
      if (protectedEntry(entry, packageNameFromModule(entry.options.name))) fail('该插件是 DSH 核心组件，不能在这里停用', 403)
      const enabled = body.enabled === true
      await updateManagedDisabled(profileDir, entry, !enabled)
      return { entryId: entry.id, enabled, hot: true }
    }),
  }))
  routes.push(webServer.register({
    kind: 'exact',
    path: `${PREFIX}/install`,
    handler: methodHandler('POST', async (req) => {
      const body = await readJsonBody(req)
      const result = await withFileLock(profileLock(profileDir), '插件设置正在被另一个操作使用', async () => installPackage(
        profileDir,
        await readProfileManifest(profileDir),
        requireString(body.spec, 'spec', 300),
        body.confirmRisk === true,
      ))
      return { ...result, hotInstaller: true, message: '已安装；dsh-hot-installer 将热挂载插件，浏览器端插件可能需要刷新页面' }
    }),
  }))
  routes.push(webServer.register({
    kind: 'exact',
    path: `${PREFIX}/uninstall`,
    handler: methodHandler('POST', async (req) => {
      const body = await readJsonBody(req)
      const result = await uninstallPackage(profileDir, loader, await readProfileManifest(profileDir), requireString(body.packageName, 'packageName', 200))
      return { ...result, hotInstaller: true, message: '已卸载；正在热卸载其 Loader 条目' }
    }),
  }))
  ctx.effect(() => () => routes.splice(0).forEach((dispose) => dispose()))
}
