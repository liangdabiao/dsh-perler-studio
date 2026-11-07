// ============================================================================
// 拼豆工坊 · 浏览器半边（Client）。
// React 组件直接挂 main 槽（官方推荐形态，不用 iframe）：左项目列表 / 右详情
// （SVG 图案预览、五套色号统计、采购清单、下载图纸 PNG / CSV / SVG）。
// 图纸 PNG 在浏览器 canvas 绘制（网格线+每格色号+统计区），数据全部来自 Host API。
// ============================================================================
const h = require('react').createElement
const { useState, useEffect, useCallback } = require('react')
const MAPPING = require('./lib/colorSystemMapping.json')

const PANEL_ID = 'perler-studio' // = cordis.patch.yml 的 id
const BASE = 'perler-studio' // = host.js 的 webServer 前缀（相对路径 fetch）
const SYSTEMS = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝']
const ERASE = 'ERASE'

// 侧栏图标（24×24 拼豆四色圆点）
function StudioIcon(props) {
  return h('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', ...props },
    h('rect', { x: 2.5, y: 2.5, width: 19, height: 19, rx: 5, fill: '#e8734a' }),
    h('circle', { cx: 8.2, cy: 8.2, r: 2.1, fill: '#fff' }),
    h('circle', { cx: 15.8, cy: 8.2, r: 2.1, fill: '#ffe08a' }),
    h('circle', { cx: 8.2, cy: 15.8, r: 2.1, fill: '#8ad2ff' }),
    h('circle', { cx: 15.8, cy: 15.8, r: 2.1, fill: '#fff' }))
}

// ---------- 数据助手 ----------

async function fetchJson(path, body) {
  const res = await fetch(BASE + path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
  return data
}

function codeOf(hex, system) {
  const entry = MAPPING[hex] || MAPPING[hex.toLowerCase()]
  return entry ? (entry[system] ?? '?') : '?'
}

function computeStats(pixelData) {
  const counts = {}
  let total = 0
  for (const row of pixelData) {
    for (const cell of row) {
      if (!cell || cell.isExternal || cell.key === ERASE) continue
      const hex = cell.color.toUpperCase()
      counts[hex] = (counts[hex] || 0) + 1
      total++
    }
  }
  const list = Object.entries(counts)
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count)
  return { list, total }
}

function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// ---------- 图纸 PNG 绘制（移植 imageDownloader.ts 精简版：标题+网格+每格色号+统计区） ----------

function renderChart(detail, system, cellSize = 30) {
  const { pixelData } = detail
  const cols = pixelData[0].length
  const rows = pixelData.length
  const { list, total } = computeStats(pixelData)

  const margin = 20
  const titleH = 46
  const boardW = cols * cellSize
  const boardH = rows * cellSize
  const statsCols = Math.min(4, Math.max(1, Math.ceil(list.length / 25)))
  const statRows = Math.ceil(list.length / statsCols)
  const statsH = list.length ? statRows * 30 + 56 : 40
  const W = boardW + margin * 2
  const H = boardH + margin * 2 + titleH + statsH

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = '#1a1a1a'
  ctx.font = 'bold 20px Consolas, "Microsoft YaHei", monospace'
  ctx.fillText(`${detail.meta.title || detail.meta.name} · ${cols}×${rows} · ${total} 粒 · ${system}`, margin, margin + 26)

  const x0 = margin
  const y0 = margin + titleH
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = pixelData[r][c]
      const x = x0 + c * cellSize
      const y = y0 + r * cellSize
      if (cell && !cell.isExternal && cell.key !== ERASE) {
        ctx.fillStyle = cell.color
        ctx.fillRect(x, y, cellSize, cellSize)
        if (cellSize >= 18) {
          const code = codeOf(cell.color.toUpperCase(), system)
          if (code && code !== '?') {
            ctx.fillStyle = luminance(cell.color.toUpperCase()) > 0.6 ? '#333333' : '#ffffff'
            ctx.font = `${Math.min(12, cellSize / 2.4)}px Consolas, monospace`
            ctx.textAlign = 'center'
            ctx.fillText(code, x + cellSize / 2, y + cellSize / 2 + 4)
            ctx.textAlign = 'left'
          }
        }
      } else {
        ctx.fillStyle = '#f0f0f0'
        ctx.fillRect(x, y, cellSize, cellSize)
      }
    }
  }

  ctx.strokeStyle = '#dddddd'
  ctx.lineWidth = 0.6
  for (let c = 0; c <= cols; c++) {
    ctx.beginPath()
    ctx.moveTo(x0 + c * cellSize, y0)
    ctx.lineTo(x0 + c * cellSize, y0 + boardH)
    ctx.stroke()
  }
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath()
    ctx.moveTo(x0, y0 + r * cellSize)
    ctx.lineTo(x0 + boardW, y0 + r * cellSize)
    ctx.stroke()
  }
  ctx.strokeStyle = '#999999'
  ctx.lineWidth = 1.2
  for (let c = 0; c <= cols; c += 10) {
    ctx.beginPath(); ctx.moveTo(x0 + c * cellSize, y0); ctx.lineTo(x0 + c * cellSize, y0 + boardH); ctx.stroke()
  }
  for (let r = 0; r <= rows; r += 10) {
    ctx.beginPath(); ctx.moveTo(x0, y0 + r * cellSize); ctx.lineTo(x0 + boardW, y0 + r * cellSize); ctx.stroke()
  }
  ctx.strokeStyle = '#555555'
  ctx.strokeRect(x0, y0, boardW, boardH)

  if (list.length) {
    const sy = y0 + boardH + 34
    ctx.fillStyle = '#1a1a1a'
    ctx.font = 'bold 15px "Microsoft YaHei", sans-serif'
    ctx.fillText(`采购清单（${list.length} 色 / ${total} 粒）`, x0, sy)
    const colW = Math.max(150, boardW / statsCols)
    list.forEach((item, idx) => {
      const cx = x0 + (idx % statsCols) * colW
      const cy = sy + 22 + Math.floor(idx / statsCols) * 30
      ctx.fillStyle = item.hex
      ctx.fillRect(cx, cy - 11, 16, 16)
      ctx.strokeStyle = '#cccccc'
      ctx.lineWidth = 1
      ctx.strokeRect(cx, cy - 11, 16, 16)
      ctx.fillStyle = '#1a1a1a'
      ctx.font = '13px Consolas, "Microsoft YaHei", monospace'
      ctx.fillText(`${codeOf(item.hex, system)} ${item.hex} × ${item.count}`, cx + 22, cy + 2)
    })
  }
  return canvas
}

function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }, 'image/png')
}

// ---------- 面板组件 ----------

function StudioPanel() {
  const [projects, setProjects] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [system, setSystem] = useState('MARD')
  const [error, setError] = useState('')
  const [converting, setConverting] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [projectName, setProjectName] = useState('')

  const loadProjects = useCallback(() => {
    fetchJson('/api/projects').then((d) => setProjects(d.projects)).catch((e) => setError(e.message))
  }, [])

  useEffect(() => { loadProjects() }, [loadProjects])

  const openProject = (name) => {
    setSelected(name)
    setDetail(null)
    fetchJson(`/api/project?name=${encodeURIComponent(name)}`)
      .then(setDetail)
      .catch((e) => setError(e.message))
  }

  const convert = async () => {
    if (!imageUrl.trim()) return
    setConverting(true)
    setError('')
    try {
      // 面板通道：图片以 dataURI（上传）或 URL（直链）给 Host；无需模型参与
      const body = imageUrl.trim().startsWith('data:')
        ? { name: projectName || autoName(), imageDataUri: imageUrl.trim() }
        : { name: projectName || autoName(), image: imageUrl.trim() }
      const out = await fetchJson('/api/convert', body)
      loadProjects()
      openProject(out.project.name)
      setImageUrl('')
    } catch (e) {
      setError(e.message)
    } finally {
      setConverting(false)
    }
  }

  const autoName = () => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `pindou-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  const stats = detail && detail.pixelData ? computeStats(detail.pixelData) : null

  const downloadPng = () => {
    if (!detail || !detail.pixelData) return
    const canvas = renderChart(detail, system, detail.gridDimensions.cols > 100 ? 22 : 30)
    downloadCanvas(canvas, `bead-grid-${detail.gridDimensions.cols}x${detail.gridDimensions.rows}-${system}.png`)
  }

  const onPickFile = (event) => {
    const file = event.target.files && event.target.files[0]
    if (!file) return
    setProjectName(projectName || file.name.replace(/\.(png|jpe?g|webp)$/i, '').slice(0, 40))
    const reader = new FileReader()
    reader.onload = () => setImageUrl(String(reader.result))
    reader.readAsDataURL(file)
  }

  return h('div', { style: styles.wrap },
    // 顶部：新建（上传图片 / 图片直链）
    h('div', { style: styles.card },
      h('div', { style: styles.row },
        h('label', { style: styles.upload },
          h('input', { type: 'file', accept: 'image/png,image/jpeg', style: { display: 'none' }, onChange: onPickFile }),
          '选择图片'),
        h('input', {
          placeholder: '或粘贴图片直链（http…）', value: imageUrl && !imageUrl.startsWith('data:') ? imageUrl : '',
          onChange: (e) => setImageUrl(e.target.value), style: { ...styles.input, flex: 1 },
        }),
        h('input', { placeholder: '项目名（可留空自动命名）', value: projectName, onChange: (e) => setProjectName(e.target.value), style: styles.input }),
        h('button', { style: styles.button, onClick: convert, disabled: converting || !imageUrl }, converting ? '转换中…' : '生成拼豆图')),
      error ? h('div', { style: styles.error }, error) : null),

    h('div', { style: { ...styles.row, alignItems: 'flex-start' } },
      // 左：项目列表
      h('div', { style: { ...styles.card, width: 220, flexShrink: 0 } },
        h('div', { style: styles.sectionTitle }, '我的项目'),
        projects === null ? h('div', { style: styles.muted }, '加载中…')
          : projects.length === 0 ? h('div', { style: styles.muted }, '还没有项目。上传一张图开始。')
            : projects.map((p) => h('div', {
              key: p.name, onClick: () => openProject(p.name),
              style: { ...styles.project, ...(selected === p.name ? styles.projectActive : {}) },
            },
              h('div', null, p.title || p.name),
              h('div', { style: styles.muted }, p.grid ? `${p.grid.cols}×${p.grid.rows} · ${p.totalBeads} 粒` : '未转换')))),

      // 右：详情
      h('div', { style: { ...styles.card, flex: 1, minHeight: 300 } },
        !selected ? h('div', { style: styles.muted }, '← 选一个项目，或先转换一张图')
          : detail === null ? h('div', { style: styles.muted }, '加载中…')
            : h('div', null,
              h('div', { style: styles.row },
                h('div', { style: styles.sectionTitle }, `${detail.meta.title || detail.meta.name}（${detail.gridDimensions.cols}×${detail.gridDimensions.rows}）`),
                h('select', { value: system, onChange: (e) => setSystem(e.target.value), style: styles.input },
                  SYSTEMS.map((s) => h('option', { key: s, value: s }, s))),
                h('button', { style: styles.button, onClick: downloadPng }, '下载图纸 PNG'),
                h('a', { href: `${BASE}/${selected}/beads.svg`, download: `beads-${selected}.svg`, style: styles.button }, 'SVG'),
                h('a', { href: `${BASE}/${selected}/beads.csv`, download: `beads-${selected}.csv`, style: styles.button }, 'CSV')),
              h('div', { style: styles.preview },
                h('img', { src: `${BASE}/${selected}/beads.svg`, alt: '拼豆图纸', style: { maxWidth: '100%' } })),
              stats ? h('div', { style: { marginTop: 12 } },
                h('div', { style: styles.sectionTitle }, `采购清单（${stats.list.length} 色 / ${stats.total} 粒）`),
                h('div', { style: styles.statsGrid },
                  stats.list.map((item) => h('div', { key: item.hex, style: styles.statRow },
                    h('span', { style: { ...styles.swatch, background: item.hex } }),
                    h('span', null, `${codeOf(item.hex, system)} ${item.hex}`),
                    h('span', { style: { marginLeft: 'auto', fontWeight: 600 } }, `× ${item.count}`))))) : null)))
  )
}

// 极简内联样式：用少量中性色，暗色模式靠 dsh 主题变量兜底不做完整跟随（二期换 --dsw-alias-* token）
const styles = {
  wrap: { padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box', fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif', fontSize: 13, color: '#1a1a1a' },
  card: { background: '#ffffff', border: '1px solid #e3e3e6', borderRadius: 10, padding: 12, marginBottom: 12 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 },
  input: { padding: '6px 10px', border: '1px solid #d9d9de', borderRadius: 8, background: '#fff', color: '#1a1a1a', outline: 'none' },
  button: { padding: '6px 14px', border: 'none', borderRadius: 8, background: '#e8734a', color: '#fff', cursor: 'pointer', textDecoration: 'none', fontSize: 13, display: 'inline-block' },
  upload: { padding: '6px 14px', borderRadius: 8, background: '#f0f0f2', color: '#1a1a1a', cursor: 'pointer', border: '1px solid #d9d9de' },
  sectionTitle: { fontWeight: 700, marginBottom: 8 },
  muted: { color: '#8a8a92' },
  project: { padding: '8px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid transparent' },
  projectActive: { background: '#fdeee8', borderColor: '#e8734a' },
  preview: { background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 10, textAlign: 'center' },
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 6 },
  statRow: { display: 'flex', gap: 8, alignItems: 'center', background: '#fafafa', borderRadius: 8, padding: '6px 10px' },
  swatch: { width: 16, height: 16, borderRadius: 4, display: 'inline-block', border: '1px solid #ccc' },
  error: { color: '#c0392b', marginTop: 6 },
}

function apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: () => '拼豆工坊' }, StudioIcon))
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, StudioPanel))
}

exports.isPlugin = true
exports.inject = ['slots']
exports.apply = apply
