// 色板：291 个标准 hex × 5 套色号系统（MARD/COCO/漫漫/盼盼/咪小窝）。
// 数据来自 perler-beads-ai（Apache-2.0）的 colorSystemMapping.json，结构：
//   { "#FBED56": { "MARD": "A04", "COCO": "E07", "漫漫": "B3", "盼盼": "3", "咪小窝": "3" }, ... }
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)))
const MAPPING = JSON.parse(readFileSync(join(ROOT, 'colorSystemMapping.json'), 'utf8'))

export const COLOR_SYSTEMS = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝']

export function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim())
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null
}

export function rgbToHex({ r, g, b }) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase()
}

export function colorDistance(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

// 全量色板：key 用 hex 本身（与原项目一致，统计/匹配主键是 hex）
export const FULL_PALETTE = Object.keys(MAPPING).map((hex) => ({
  key: hex.toUpperCase(),
  hex: hex.toUpperCase(),
  rgb: hexToRgb(hex),
}))

const PALETTE_BY_HEX = new Map(FULL_PALETTE.map((p) => [p.hex, p]))

export function normalizeHex(hex) {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToHex(rgb) : null
}

/** hex → 5 套色号；未知色返回 null */
export function lookupHex(hex) {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const mapping = MAPPING[normalized] || MAPPING[normalized.toLowerCase()]
  if (!mapping) return null
  return { hex: normalized, ...mapping }
}

/** 色板内最近的颜色（欧氏距离；精确匹配提前退出）。可指定子集（自定义色板场景预留）。 */
export function nearestPaletteColors(rgb, limit = 5, palette = FULL_PALETTE) {
  const scored = palette
    .map((p) => ({ ...p, distance: colorDistance(rgb, p.rgb) }))
    .sort((a, b) => a.distance - b.distance)
  return scored.slice(0, Math.max(1, limit))
}

export function findClosestPaletteColor(targetRgb, palette = FULL_PALETTE) {
  if (!palette || palette.length === 0) throw new Error('色板为空')
  let min = Infinity
  let closest = palette[0]
  for (const p of palette) {
    const d = colorDistance(targetRgb, p.rgb)
    if (d < min) {
      min = d
      closest = p
    }
    if (d === 0) break
  }
  return closest
}

/** hex 在指定色号系统里的色号；找不到返回 '?'（与原项目一致） */
export function getDisplayColorKey(hex, system = 'MARD') {
  const entry = lookupHex(hex)
  return entry ? (entry[system] ?? '?') : '?'
}

export function paletteInfo() {
  return { colors: FULL_PALETTE.length, systems: COLOR_SYSTEMS }
}
