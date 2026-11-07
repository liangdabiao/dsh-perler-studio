// 导出层：SVG 图纸（网格线 + 每格色号文字 + 标题 + 统计表）与 CSV（hex 矩阵）。
// SVG 纯字符串生成——浏览器/打印可直接看；PNG 图纸由浏览器面板用 canvas 绘制下载。
// CSV 格式与 perler-beads-ai 一致：每行 N 个 hex，外部/擦除格写 TRANSPARENT（可再导入）。
import { getDisplayColorKey } from './palette.js'

/** 采购清单：[{ hex, code, count }] 按数量降序 */
export function shoppingList(colorCounts, system = 'MARD') {
  return Object.values(colorCounts)
    .map(({ color, count }) => ({ hex: color, code: getDisplayColorKey(color, system), count }))
    .sort((a, b) => b.count - a.count)
}

/** CSV 图案矩阵（hex + TRANSPARENT），可被 importCsv 回读 */
export function toCsv(pixelData) {
  return pixelData
    .map((row) => row.map((cell) => (cell && !cell.isExternal && cell.key !== 'ERASE' ? cell.color.toUpperCase() : 'TRANSPARENT')).join(','))
    .join('\n')
}

/** CSV → MappedPixel[][]（面板/测试的往返路径） */
export function fromCsv(text) {
  const rows = String(text).trim().split(/\r?\n/).map((line) => line.split(','))
  return rows.map((row) =>
    row.map((value) => {
      const hex = value.trim().toUpperCase()
      if (!hex || hex === 'TRANSPARENT') return { key: 'ERASE', color: '#FFFFFF', isExternal: true }
      return { key: hex, color: hex }
    }))
}

/** SVG 图纸：cellSize=30，含标题栏、网格线、每格色号、统计表（按数量降序，分列排布） */
export function toSvg(pixelData, { colorCounts, totalBeads }, { title = '拼豆图纸', system = 'MARD', cellSize = 30, gridInterval = 10 } = {}) {
  const rows = pixelData.length
  const cols = pixelData[0].length
  const label = (hex) => {
    const code = getDisplayColorKey(hex, system)
    return code === '?' ? '' : code
  }

  const boardW = cols * cellSize
  const boardH = rows * cellSize
  const margin = 20
  const titleH = 46
  const statsCols = Math.min(4, Math.max(1, Math.ceil(Object.keys(colorCounts).length / 25)))
  const statRows = Math.ceil(Object.keys(colorCounts).length / statsCols)
  const statsH = Object.keys(colorCounts).length ? statRows * 30 + 56 : 40
  const W = boardW + margin * 2
  const H = boardH + margin * 2 + titleH + statsH

  const parts = []
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`)
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Consolas, 'Microsoft YaHei', monospace">`)
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`)
  parts.push(`<text x="${margin}" y="${margin + 24}" font-size="20" font-weight="bold" fill="#1a1a1a">${esc(title)} · ${cols}×${rows} · ${totalBeads} 粒 · 色号体系 ${esc(system)}</text>`)

  // 色块 + 色号文字
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = pixelData[r][c]
      const x = margin + c * cellSize
      const y = margin + titleH + r * cellSize
      if (cell && !cell.isExternal && cell.key !== 'ERASE') {
        parts.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${cell.color}"/>`)
        if (cellSize >= 18) {
          const code = label(cell.color)
          if (code) {
            const luminance = luminanceOf(cell.color)
            const fill = luminance > 0.6 ? '#333333' : '#ffffff'
            parts.push(`<text x="${x + cellSize / 2}" y="${y + cellSize / 2 + 4}" font-size="${Math.min(12, cellSize / 2.4)}" text-anchor="middle" fill="${fill}">${esc(code)}</text>`)
          }
        }
      } else {
        parts.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="#f0f0f0"/>`)
      }
    }
  }

  // 网格线（细线每格，粗线每 gridInterval 格）
  for (let c = 0; c <= cols; c++) {
    const bold = c % gridInterval === 0
    parts.push(`<line x1="${margin + c * cellSize}" y1="${margin + titleH}" x2="${margin + c * cellSize}" y2="${margin + titleH + boardH}" stroke="${bold ? '#999' : '#ddd'}" stroke-width="${bold ? 1.2 : 0.6}"/>`)
  }
  for (let r = 0; r <= rows; r++) {
    const bold = r % gridInterval === 0
    parts.push(`<line x1="${margin}" y1="${margin + titleH + r * cellSize}" x2="${margin + boardW}" y2="${margin + titleH + r * cellSize}" stroke="${bold ? '#999' : '#ddd'}" stroke-width="${bold ? 1.2 : 0.6}"/>`)
  }
  parts.push(`<rect x="${margin}" y="${margin + titleH}" width="${boardW}" height="${boardH}" fill="none" stroke="#555" stroke-width="1.5"/>`)

  // 统计表
  if (Object.keys(colorCounts).length) {
    const sy = margin + titleH + boardH + 34
    parts.push(`<text x="${margin}" y="${sy}" font-size="15" font-weight="bold" fill="#1a1a1a">采购清单（${Object.keys(colorCounts).length} 色 / ${totalBeads} 粒）</text>`)
    const list = shoppingList(colorCounts, system)
    const colW = Math.max(150, boardW / statsCols)
    list.forEach((item, idx) => {
      const cx = margin + (idx % statsCols) * colW
      const cy = sy + 22 + Math.floor(idx / statsCols) * 30
      parts.push(`<rect x="${cx}" y="${cy - 11}" width="16" height="16" fill="${item.hex}" stroke="#ccc"/>`)
      parts.push(`<text x="${cx + 22}" y="${cy + 2}" font-size="13" fill="#1a1a1a">${esc(item.code)} ${item.hex} × ${item.count}</text>`)
    })
  }

  parts.push('</svg>')
  return parts.join('\n')
}

function luminanceOf(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
