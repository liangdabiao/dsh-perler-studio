// 共享操作层：转换/读取/列项目的真正逻辑。工具与面板 API 都走这里（一份逻辑两个入口）。
// convert：解码图片 → 量化 → 存 pattern.json + beads.svg + beads.csv + source.png。
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeImage, encodePng, sniffImage } from './decode.js'
import { pixelate, computeStats } from './pixelate.js'
import { COLOR_SYSTEMS, normalizeHex } from './palette.js'
import { toCsv, toSvg, shoppingList } from './exporter.js'
import { dataRoot, initProject, readProject, listProjects, writeJsonAtomic, writeTextAtomic, updateMeta, isValidProjectName } from './project.js'
import { resolveImageBuffer, ImageSourceError } from './imageSource.js'

export { ImageSourceError }

const normName = (value) => {
  const name = String(value || '').trim()
  if (!isValidProjectName(name)) throw new Error(`项目名不合法：${value}（不要含路径分隔符/空格，别以点开头，≤64 字符）`)
  return name
}

/**
 * 转换主流程。source 参数（三选一，由调用方决定通道）：
 *   image       —— 工具通道：绝对路径 / URL / dataURI / "attachments"
 *   imageDataUri—— 面板通道：dataURI
 *   imagePath   —— 面板通道：绝对路径
 */
export async function convertFlow(args = {}) {
  const name = normName(args.name)
  const system = COLOR_SYSTEMS.includes(args.system) ? args.system : 'MARD'
  const opts = {
    granularity: clampNum(args.granularity, 50, 5, 200),
    mode: ['dominant', 'average'].includes(args.mode) ? args.mode : 'dominant',
    mergeThreshold: clampNum(args.mergeThreshold, 30, 0, 255),
    removeBg: args.removeBg !== false,
    system,
  }

  let buffer
  if (args.image !== undefined) buffer = await resolveImageBuffer(args.image)
  else if (typeof args.imageDataUri === 'string' && args.imageDataUri.startsWith('data:image/')) {
    buffer = Buffer.from(args.imageDataUri.split(',')[1] || '', 'base64')
  } else if (typeof args.imagePath === 'string') {
    buffer = await readFile(args.imagePath).catch(() => { throw new Error(`读不到图片：${args.imagePath}`) })
  } else {
    throw new Error('缺少图片：给 image（工具）或 imageDataUri / imagePath（面板）')
  }

  const image = decodeImage(buffer)
  const result = pixelate(image, opts)
  const dir = join(dataRoot(), name)

  // 产物：pattern.json（可回读）、SVG 图纸、CSV 矩阵、原图副本
  writeJsonAtomic(join(dir, 'pattern.json'), {
    gridDimensions: result.gridDimensions,
    pixelData: result.pixelData,
  })
  writeTextAtomic(join(dir, 'beads.svg'), toSvg(result.pixelData, { colorCounts: result.colorCounts, totalBeads: result.totalBeads }, { title: name, system }))
  writeTextAtomic(join(dir, 'beads.csv'), toCsv(result.pixelData))
  await writeFile(join(dir, 'source.png'), reencodeAsPng(buffer)).catch(() => {})

  const list = shoppingList(result.colorCounts, system)
  const meta = {
    name,
    title: typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 64) : name,
    updatedAt: new Date().toISOString(),
    status: 'ready',
    grid: result.gridDimensions,
    totalBeads: result.totalBeads,
    colorCount: Object.keys(result.colorCounts).length,
    system,
    source: { ...result.source, type: sniffImage(buffer), bytes: buffer.length },
    removedBackgroundKey: result.removedBackgroundKey || null,
    mergedColors: result.mergedColors,
    inputs: { granularity: opts.granularity, mode: opts.mode, mergeThreshold: opts.mergeThreshold, removeBg: opts.removeBg },
    topColors: list.slice(0, 10),
  }
  writeJsonAtomic(join(dir, 'project.json'), meta)

  return { meta, colorCounts: result.colorCounts, totalBeads: result.totalBeads, shoppingList: list, removedBackgroundKey: result.removedBackgroundKey, mergedColors: result.mergedColors, dir }
}

/** 面板/测试读项目：meta + pattern + svg/csv 文件名 */
export function readFlow(name) {
  const { meta, pattern } = readProject(normName(name))
  return {
    meta,
    gridDimensions: pattern?.gridDimensions || null,
    pixelData: pattern?.pixelData || null,
    files: ['beads.svg', 'beads.csv', 'source.png'],
  }
}

export function listFlow() {
  return listProjects()
}

/** 采购清单（可独立按已存项目计算） */
export function shoppingListFlow(name, system = 'MARD') {
  const { meta, pattern } = readProject(normName(name))
  if (!pattern) throw new Error(`项目还没有图案：${name}（先 convert）`)
  const sys = COLOR_SYSTEMS.includes(system) ? system : meta.system || 'MARD'
  const counts = pattern.pixelData ? computeStats(pattern.pixelData).colorCounts : {}
  return shoppingList(counts, sys)
}

/** 重算（改参数重转同一张源图） */
export async function reconvertFlow(name, overrides = {}) {
  const { meta } = readProject(normName(name))
  const previous = meta.inputs || {}
  const merged = { ...previous, ...overrides }
  const sourcePath = join(dataRoot(), name, 'source.png')
  return convertFlow({
    name,
    title: meta.title,
    system: overrides.system || meta.system,
    imagePath: sourcePath,
    ...merged,
  })
}

function clampNum(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// webp/gif 等中间格式先落不下：统一重编码为 PNG 存副本（解码失败时静默跳过）
function reencodeAsPng(buffer) {
  try {
    const image = decodeImage(buffer)
    return Buffer.from(encodePng(image))
  } catch {
    return buffer
  }
}
