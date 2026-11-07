// 量化管线（移植自 perler-beads-ai，Apache-2.0）：
//   ① 网格代表色池化（dominant 主色 / average 均值）→ ② 色板最近色匹配
//   → ③ 全局频率合并近似色（阈值）→ ④ 边界洪水填充去背景 → ⑤ 统计
// 全部纯函数：输入 RGBA 像素数组，输出 MappedPixel[][] 与统计，无 IO。
import { findClosestPaletteColor, colorDistance } from './palette.js'

export const MODES = ['dominant', 'average']
export const TRANSPARENT_KEY = 'ERASE'
export const TRANSPARENT_CELL = { key: TRANSPARENT_KEY, color: '#FFFFFF', isExternal: true }

/** 单元格代表色：dominant 取格内出现频率最高的 RGB（忽略 alpha<128），average 取均值 */
function cellRepresentative(data, width, x0, y0, x1, y1, mode) {
  let rSum = 0, gSum = 0, bSum = 0, count = 0
  const freq = new Map()
  let dominant = null
  let maxCount = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] < 128) continue
      const r = data[i], g = data[i + 1], b = data[i + 2]
      count++
      if (mode === 'average') {
        rSum += r; gSum += g; bSum += b
      } else {
        const key = `${r},${g},${b}`
        const n = (freq.get(key) || 0) + 1
        freq.set(key, n)
        if (n > maxCount) { maxCount = n; dominant = { r, g, b } }
      }
    }
  }
  if (count === 0) return null
  if (mode === 'average') {
    return { r: Math.round(rSum / count), g: Math.round(gSum / count), b: Math.round(bSum / count) }
  }
  return dominant
}

/**
 * 主入口：图片像素 → 拼豆网格。
 * @param image {width, height, data} RGBA
 * @param opts {granularity=50, mode='dominant', mergeThreshold=30, removeBg=true, palette?}
 * @returns {gridDimensions:{cols,rows}, pixelData, colorCounts, totalBeads, sourceColors}
 */
export function pixelate(image, opts = {}) {
  const { width, height, data } = image
  if (!width || !height || !data) throw new Error('图片像素数据无效')
  const cols = Math.max(1, Math.min(200, Math.round(opts.granularity ?? 50)))
  const rows = Math.max(1, Math.round(cols * height / width))
  const mode = MODES.includes(opts.mode) ? opts.mode : 'dominant'
  const mergeThreshold = Math.max(0, Math.min(255, Number(opts.mergeThreshold ?? 30)))
  const removeBg = opts.removeBg !== false
  const palette = opts.palette

  // ①② 逐格取代表色并匹配色板
  const grid = []
  const cellW = width / cols
  const cellH = height / rows
  for (let j = 0; j < rows; j++) {
    const row = []
    for (let i = 0; i < cols; i++) {
      const x0 = Math.floor(i * cellW)
      const y0 = Math.floor(j * cellH)
      const x1 = Math.min(width, Math.ceil((i + 1) * cellW))
      const y1 = Math.min(height, Math.ceil((j + 1) * cellH))
      const rep = cellRepresentative(data, width, x0, y0, x1, y1, mode)
      row.push(rep
        ? (() => { const bead = findClosestPaletteColor(rep, palette); return { key: bead.key, color: bead.hex } })()
        : { ...TRANSPARENT_CELL })
    }
    grid.push(row)
  }

  // ③ 全局频率合并：低频色与高频色距离 < 阈值 → 整体并入高频色
  const initialCounts = new Map()
  for (const row of grid) {
    for (const cell of row) {
      if (cell.isExternal || cell.key === TRANSPARENT_KEY) continue
      initialCounts.set(cell.key, (initialCounts.get(cell.key) || 0) + 1)
    }
  }
  const byFreq = [...initialCounts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key)
  const replaced = new Set()
  for (let i = 0; i < byFreq.length; i++) {
    const hiKey = byFreq[i]
    if (replaced.has(hiKey)) continue
    const hiRgb = requireRgb(hiKey)
    for (let j = i + 1; j < byFreq.length; j++) {
      const loKey = byFreq[j]
      if (replaced.has(loKey)) continue
      if (colorDistance(hiRgb, requireRgb(loKey)) < mergeThreshold) {
        replaced.add(loKey)
        for (const row of grid) {
          for (const cell of row) {
            if (cell.key === loKey) { cell.key = hiKey; cell.color = hiKey; cell.isExternal = false }
          }
        }
      }
    }
  }

  // ④ 一键去背景：统计四边边缘最高频色，从边缘洪水填充标记外部
  let bgKey = null
  if (removeBg) {
    bgKey = removeBackground(grid, rows, cols)
  }

  // ⑤ 统计
  const { colorCounts, totalBeads } = computeStats(grid)
  return {
    gridDimensions: { cols, rows },
    pixelData: grid,
    colorCounts,
    totalBeads,
    removedBackgroundKey: bgKey,
    mergedColors: replaced.size,
    source: { width, height },
  }
}

function requireRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return { r, g, b }
}

/** 边界洪水填充去背景：返回被判定为背景的色号（hex），无背景/会清空全图时返回 null（保护纯色图） */
export function removeBackground(grid, rows = grid.length, cols = grid[0]?.length) {
  if (!rows || !cols) return null
  const borderFreq = new Map()
  const countBorder = (r, c) => {
    const cell = grid[r]?.[c]
    if (!cell || cell.isExternal || cell.key === TRANSPARENT_KEY) return
    borderFreq.set(cell.key, (borderFreq.get(cell.key) || 0) + 1)
  }
  for (let c = 0; c < cols; c++) { countBorder(0, c); if (rows > 1) countBorder(rows - 1, c) }
  for (let r = 1; r < rows - 1; r++) { countBorder(r, 0); if (cols > 1) countBorder(r, cols - 1) }
  if (borderFreq.size === 0) return null
  let target = null, max = -1
  for (const [key, n] of borderFreq) if (n > max) { max = n; target = key }
  if (max <= 0) return null

  // 先完整探测（洪水填充跑完）再决定：背景必须留下至少 1 粒豆（纯色图/全图同色时跳过去背景）
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false))
  const reachable = []
  const push = (r, c) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols || visited[r][c]) return
    const cell = grid[r][c]
    if (!cell || cell.isExternal || cell.key !== target) return
    visited[r][c] = true
    reachable.push([r, c])
  }
  for (let c = 0; c < cols; c++) { push(0, c); if (rows > 1) push(rows - 1, c) }
  for (let r = 1; r < rows - 1; r++) { push(r, 0); if (cols > 1) push(r, cols - 1) }
  for (let i = 0; i < reachable.length; i++) {
    const [r, c] = reachable[i]
    push(r - 1, c); push(r + 1, c); push(r, c - 1); push(r, c + 1)
  }
  if (reachable.length === 0 || reachable.length >= rows * cols) return null
  for (const [r, c] of reachable) {
    grid[r][c] = { ...TRANSPARENT_CELL }
  }
  return target
}

/** 颜色统计（跳过外部/擦除格） */
export function computeStats(grid) {
  const colorCounts = {}
  let totalBeads = 0
  for (const row of grid) {
    for (const cell of row) {
      if (!cell || cell.isExternal || cell.key === TRANSPARENT_KEY) continue
      const hex = cell.color.toUpperCase()
      colorCounts[hex] = colorCounts[hex] || { count: 0, color: hex }
      colorCounts[hex].count++
      totalBeads++
    }
  }
  return { colorCounts, totalBeads }
}
