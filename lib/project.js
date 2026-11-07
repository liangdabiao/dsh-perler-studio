// 项目持久化：$DSH_HOME/perler-studio/<项目名>/。
// 每个项目：project.json（元数据+统计）+ pattern.json（网格）+ beads.svg + beads.csv + source.png。
// 纪律：原子写（tmp+rename）、双进程 mtime 重读、路径 assertInside（越界拒绝）。
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, realpathSync, readdirSync } from 'node:fs'

export const dataRoot = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'perler-studio')

/** 路径必须落在 base 内（拒绝绝对路径注入/穿越），返回 resolve 后的绝对路径 */
export function assertInside(base, rel) {
  const absBase = resolve(base)
  const target = resolve(absBase, rel)
  if (target !== absBase && !target.startsWith(absBase + sep)) {
    throw new Error(`路径越界：${rel} 必须位于 ${absBase} 内`)
  }
  return target
}

export function isValidProjectName(name) {
  return typeof name === 'string' && /^[^\\/:*?"<>|\s]{1,64}$/.test(name) && !name.startsWith('.')
}

/** 原子写 JSON */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

/** 原子写文本 */
export function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** 双进程安全读：mtime 变了才重新解析 */
export function readJsonCached(file, cacheRef) {
  if (!existsSync(file)) return null
  const mtimeMs = statSync(file).mtimeMs
  if (cacheRef.mtimeMs !== mtimeMs || cacheRef.value === null) {
    try {
      cacheRef.mtimeMs = mtimeMs
      cacheRef.value = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      cacheRef.mtimeMs = mtimeMs
      cacheRef.value = null
    }
  }
  return cacheRef.value
}

/** 初始化一个项目目录（名字即目录名），返回 project.json 数据 */
export function initProject(name, meta = {}) {
  if (!isValidProjectName(name)) throw new Error(`项目名不合法：${name}（不要含路径分隔符/空格/以点开头）`)
  const dir = join(dataRoot(), name)
  if (existsSync(join(dir, 'project.json'))) throw new Error(`项目已存在：${name}（read 直接看，或换一个名字）`)
  const project = {
    name,
    title: meta.title || name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'empty',
  }
  writeJsonAtomic(join(dir, 'project.json'), project)
  return project
}

/** 列出全部项目（project.json 摘要） */
export function listProjects() {
  const root = dataRoot()
  if (!existsSync(root)) return []
  let names = []
  try { names = readdirSync(root) } catch { return [] }
  return names
    .filter((name) => isValidProjectName(name) && existsSync(join(root, name, 'project.json')))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(root, name, 'project.json'), 'utf8'))
      } catch {
        return { name, status: 'corrupt' }
      }
    })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

/** 读项目（project.json + pattern.json + 统计） */
export function readProject(name) {
  if (!isValidProjectName(name)) throw new Error(`项目名不合法：${name}`)
  const dir = join(dataRoot(), name)
  const metaFile = join(dir, 'project.json')
  if (!existsSync(metaFile)) throw new Error(`项目不存在：${name}`)
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
  let pattern = null
  if (existsSync(join(dir, 'pattern.json'))) {
    try { pattern = JSON.parse(readFileSync(join(dir, 'pattern.json'), 'utf8')) } catch { pattern = null }
  }
  return { meta, pattern, dir }
}

/** 保存转换产物（project.json 元数据 + pattern.json + 统计回写） */
export function savePattern(name, { imageInfo, result, system, inputs }) {
  const dir = join(dataRoot(), name)
  const { gridDimensions, pixelData, colorCounts, totalBeads, removedBackgroundKey, mergedColors, source } = result
  const meta = {
    name,
    title: name,
    updatedAt: new Date().toISOString(),
    status: 'ready',
    grid: gridDimensions,
    totalBeads,
    colorCount: Object.keys(colorCounts).length,
    system,
    source: { ...source, ...imageInfo },
    removedBackgroundKey: removedBackgroundKey || null,
    mergedColors,
    inputs: inputs || {},
  }
  writeJsonAtomic(join(dir, 'project.json'), meta)
  writeJsonAtomic(join(dir, 'pattern.json'), {
    gridDimensions,
    pixelData,
  })
  return meta
}

/** 更新元数据（保留其余字段，原子写） */
export function updateMeta(name, patch) {
  const dir = join(dataRoot(), name)
  const metaFile = join(dir, 'project.json')
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : { name }
  const next = { ...meta, ...patch, name, updatedAt: new Date().toISOString() }
  writeJsonAtomic(metaFile, next)
  return next
}

/** realpath 复核（safeFile 用）：文件必须存在且在 base 内 */
export function safeFileUnder(base, rel) {
  try {
    if (String(rel).split(/[\\/]/).some((seg) => seg.startsWith('.'))) return null
    const absBase = realpathSync(base)
    const target = resolve(absBase, rel)
    if (target !== absBase && !target.startsWith(absBase + sep)) return null
    const real = realpathSync(target)
    if (real !== target || !real.startsWith(absBase + sep) || !statSync(real).isFile()) return null
    return real
  } catch {
    return null
  }
}
