// 把 dsh-lark-bot 的最新构建同步进 DSH web profile。
//
// 为什么需要它：profile 的 node_modules\dsh-lark-bot 是 file: 依赖的【复制件】（不是符号链接），
// 而 pnpm install 在该依赖版本号未变时不会重拷；运行中的 dsh 还会占用其中的文件。
// 所以每次改完 lark 源码，必须先跑这个脚本（DSH 停机时最稳），再启动 DSH。
//
// 用法：node tools/sync-to-profile.mjs            # 直接覆盖
//       node tools/sync-to-profile.mjs --dry-run  # 只看会改什么
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..')
const dst = process.env.DSH_LARK_TARGET
  ?? 'E:/DeepSeekHarness/dsh-home/profiles/web/node_modules/dsh-lark-bot'
const dry = process.argv.includes('--dry-run')

const hash = (p) => {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) } catch { return 'MISSING' }
}

/**
 * Signature of a whole dist directory: every file's name, size and content
 * hash. Comparing a single file (as an earlier version did with plugin.js)
 * misses changes confined to other chunks — e.g. notify.js — and reports
 * "already in sync" while the profile keeps running stale code.
 */
function distSignature(dir) {
  if (!existsSync(dir)) return 'MISSING'
  const acc = createHash('sha256')
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isFile()) continue
    acc.update(`${name}:${stat.size}:`)
    try { acc.update(readFileSync(full)) } catch { acc.update('UNREADABLE') }
  }
  return acc.digest('hex').slice(0, 16)
}

if (!existsSync(dst)) {
  console.error(`target not found: ${dst}`)
  process.exit(1)
}

const before = distSignature(join(dst, 'dist'))
const after = distSignature(join(src, 'dist'))
const companionFiles = ['package.json', 'cordis.patch.yml', 'dsh-plugin.json']
const companionChanges = companionFiles.filter((file) => hash(join(src, file)) !== hash(join(dst, file)))
console.log(`source dist ${after}`)
console.log(`target dist ${before}`)
if (companionChanges.length > 0) console.log(`metadata drift: ${companionChanges.join(', ')}`)
if (before === after && companionChanges.length === 0) {
  console.log('already in sync - nothing to do')
  process.exit(0)
}
if (dry) {
  console.log('drift detected (dry run, nothing written)')
  process.exit(2)
}

// dist 是整目录替换：先删旧目录再拷，避免残留已删除的 chunk。
const targetDist = join(dst, 'dist')
if (before !== after) {
  try {
    rmSync(targetDist, { recursive: true, force: true })
  } catch (error) {
    console.error(`cannot replace ${targetDist}: ${String(error?.message ?? error)}`)
    console.error('close DSH first (graceful tray exit), then re-run.')
    process.exit(1)
  }
  mkdirSync(targetDist, { recursive: true })
  cpSync(join(src, 'dist'), targetDist, { recursive: true })
} else {
  console.log('dist already in sync; updating metadata only')
}

for (const file of companionFiles) {
  if (hash(join(src, file)) === hash(join(dst, file))) continue
  try {
    cpSync(join(src, file), join(dst, file))
  } catch (error) {
    console.error(`cannot copy ${file}: ${String(error?.message ?? error)}`)
    console.error('close DSH first (graceful tray exit), then re-run.')
    process.exit(1)
  }
}

const files = readdirSync(targetDist).length
const now = distSignature(targetDist)
console.log(`copied ${files} files into ${targetDist}`)
console.log(`target dist now ${now}`)
const metadataOk = companionFiles.every((file) => hash(join(src, file)) === hash(join(dst, file)))
console.log(now === after && metadataOk ? 'SYNC OK' : 'SYNC MISMATCH - target is locked by a running dsh; stop it and re-run')
process.exit(now === after && metadataOk ? 0 : 1)
