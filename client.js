// ============================================================================
// 拼豆工坊 · 浏览器半边（Client）。
// React 组件直接挂 main 槽（官方推荐形态，不用 iframe）：左项目列表 / 右详情
// （SVG 图案预览、五套色号统计、采购清单、下载图纸 PNG / CSV / SVG）。
// 图纸 PNG 在浏览器 canvas 绘制（网格线+每格色号+统计区），数据全部来自 Host API。
// ============================================================================
const h = require('react').createElement
const { useState, useEffect, useCallback, useRef } = require('react')
const MAPPING = require('./lib/colorSystemMapping.json')
const { getAllConnectedRegions, getConnectedRegion, sortRegionsByDistance, sortRegionsBySize, isRegionCompleted, clientToGrid } = require('./lib/regions.js')

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

// 网格绘制核心（renderChart 与 LivePreview 共用）：格子填色 + 色号 + 每 10 格粗线
function drawBoard(ctx, detail, system, cellSize, x0, y0) {
  const { pixelData } = detail
  const cols = pixelData[0].length
  const rows = pixelData.length
  const boardW = cols * cellSize
  const boardH = rows * cellSize
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
    ctx.beginPath(); ctx.moveTo(x0 + c * cellSize, y0); ctx.lineTo(x0 + c * cellSize, y0 + boardH); ctx.stroke()
  }
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath(); ctx.moveTo(x0, y0 + r * cellSize); ctx.lineTo(x0 + boardW, y0 + r * cellSize); ctx.stroke()
  }
  ctx.strokeStyle = '#999999'
  ctx.lineWidth = 1
  for (let c = 10; c <= cols; c += 10) {
    ctx.beginPath(); ctx.moveTo(x0 + c * cellSize, y0); ctx.lineTo(x0 + c * cellSize, y0 + boardH); ctx.stroke()
  }
  for (let r = 10; r <= rows; r += 10) {
    ctx.beginPath(); ctx.moveTo(x0, y0 + r * cellSize); ctx.lineTo(x0 + boardW, y0 + r * cellSize); ctx.stroke()
  }
}

function renderChart(detail, system, cellSize = 30) {
  const { pixelData } = detail
  const cols = pixelData[0].length
  const rows = pixelData.length
  const { list, total } = computeStats(pixelData)

  const margin = 20
  const titleH = 46
  const boardW = cols * cellSize
  const boardH = rows * cellSize
  // 横排：按图纸宽度放列（每列约 180px），宽度足够时清单横向铺开
  const statsCols = Math.max(1, Math.min(6, Math.floor(boardW / 180)))
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
  drawBoard(ctx, detail, system, cellSize, x0, y0)


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


// ---------- AI 密钥设置（面板内直配，存本机 $DSH_HOME，永不上传/回显明文） ----------
function SettingsPanel() {
  const [info, setInfo] = useState(null)
  const [ak, setAk] = useState('')
  const [sk, setSk] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(() => {
    fetchJson('/api/config').then(setInfo).catch((e) => setError(e.message))
  }, [])
  useEffect(() => { load() }, [load])
  const save = async () => {
    setError(''); setMsg('')
    if (!ak.trim() && !sk.trim()) { setError('先粘贴 AccessKeyId / SecretAccessKey。'); return }
    try {
      const d = await fetchJson('/api/config', { volcAccessKeyId: ak.trim(), volcSecretAccessKey: sk.trim() })
      setInfo(d.credentials); setAk(''); setSk('')
      setMsg('已保存（存本机 $DSH_HOME/perler-studio/settings.json，不会上传）。现在可以点「AI 风格化生成」了。')
    } catch (e) { setError(e.message) }
  }
  const clear = async () => {
    setError(''); setMsg('')
    try {
      const res = await fetch(BASE + '/api/config', { method: 'DELETE' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || '清除失败')
      setInfo(d.credentials); setMsg('已清除本机保存的密钥。')
    } catch (e) { setError(e.message) }
  }
  return h('div', { style: styles.card },
    h('div', { style: styles.sectionTitle }, '⚙️ AI 风格化密钥（火山引擎 · 即梦 4.0）'),
    info === null ? h('div', { style: styles.muted }, '加载中…')
      : h('div', { style: styles.muted },
          info.configured
            ? `已配置 ✓（${info.accessKeyMasked} / ${info.secretKeyMasked}）`
            : '未配置。粘贴下面两项并保存，即可使用「AI 风格化生成」。'),
    h('div', { style: styles.settingsField }, h('input', {
      type: 'password', placeholder: 'AccessKeyId', value: ak, onChange: (e) => setAk(e.target.value), style: styles.input,
    })),
    h('div', { style: styles.settingsField }, h('input', {
      type: 'password', placeholder: 'SecretAccessKey', value: sk, onChange: (e) => setSk(e.target.value), style: styles.input,
    })),
    h('div', { style: styles.row },
      h('button', { style: styles.button, onClick: save }, '保存密钥'),
      info?.configured ? h('button', { style: styles.buttonSecondary, onClick: clear }, '清除已存密钥') : null),
    msg ? h('div', { style: styles.ok }, msg) : null,
    error ? h('div', { style: styles.error }, error) : null,
    h('div', { style: { ...styles.muted, fontSize: 12, lineHeight: 1.8 } },
      '获取方式：火山引擎控制台 → 右上角头像 →「API 访问密钥」→ 新建一对 AccessKeyId / SecretAccessKey（需开通即梦/视觉智能服务）。',
      h('br'), '密钥只存在你本机（$DSH_HOME/perler-studio/settings.json），任何接口都不会回显明文。'))
}


// ---------- 实时预览：客户端 canvas 渲染，色号系统切换即时生效 ----------
function LivePreview({ detail, system }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !detail?.pixelData) return
    const cols = detail.gridDimensions.cols
    const rows = detail.gridDimensions.rows
    const cell = Math.max(5, Math.min(26, Math.floor(920 / cols)))
    canvas.width = cols * cell + 40
    canvas.height = rows * cell + 40
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    drawBoard(ctx, detail, system, cell, 20, 20)
  }, [detail, system])
  return h('canvas', { ref, style: { maxWidth: '100%', display: 'block', margin: '0 auto' } })
}

function StudioPanel() {
  const [projects, setProjects] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [system, setSystem] = useState('MARD')
  const [error, setError] = useState('')
  const [converting, setConverting] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeSeconds, setOptimizeSeconds] = useState(0)
  const [aiReady, setAiReady] = useState(null) // null=未知
  const [imageUrl, setImageUrl] = useState('')
  const [pickedInfo, setPickedInfo] = useState('')
  const [projectName, setProjectName] = useState('')
  const [focusMode, setFocusMode] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [reconvertSize, setReconvertSize] = useState(null)
  const [reconverting, setReconverting] = useState(false)

  const loadProjects = useCallback(() => {
    fetchJson('/api/projects').then((d) => setProjects(d.projects)).catch((e) => setError(e.message))
    fetchJson('/api/health').then((d) => setAiReady(Boolean(d.ai))).catch(() => setAiReady(false))
  }, [])

  useEffect(() => { loadProjects() }, [loadProjects])

  // AI 风格化计时器
  useEffect(() => {
    if (!optimizing) return
    const timer = setInterval(() => setOptimizeSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [optimizing])

  const openProject = (name) => {
    setSelected(name)
    setDetail(null)
    setFocusMode(false)
    fetchJson(`/api/project?name=${encodeURIComponent(name)}`)
      .then((d) => { setDetail(d); setReconvertSize(d.gridDimensions ? d.gridDimensions.cols : 50) })
      .catch((e) => setError(e.message))
  }

  const convert = async (optimizeFirst = false) => {
    if (!imageUrl.trim()) {
      setError('还没有图片：先点「选择图片」选一张，或粘贴图片直链。')
      return
    }
    setError('')
    const body = imageUrl.trim().startsWith('data:')
      ? { name: projectName || autoName(), imageDataUri: imageUrl.trim() }
      : { name: projectName || autoName(), image: imageUrl.trim() }
    if (optimizeFirst) {
      // AI 风格化（火山即梦 4.0）+ 自动重转，最长约 3 分钟
      if (aiReady === false) {
        setError('还没有配置火山引擎 AK/SK：插件 → dsh-perler-studio → Configuration 填入后才能用 AI 风格化。可以直接「生成拼豆图」跳过 AI。')
        return
      }
      setConverting(true)
      setOptimizing(true)
      setOptimizeSeconds(0)
      try {
        const out = await fetchJson('/api/optimize', body)
        loadProjects()
        openProject(out.project.name)
        setImageUrl('')
        setPickedInfo('')
      } catch (e) {
        setError(e.message)
      } finally {
        setOptimizing(false)
        setConverting(false)
      }
      return
    }
    setConverting(true)
    try {
      const out = await fetchJson('/api/convert', body)
      loadProjects()
      openProject(out.project.name)
      setImageUrl('')
      setPickedInfo('')
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
    setError('')
    setProjectName(projectName || file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40))
    // 统一走浏览器解码 → 长边 >1500px 自动缩小 → 重编码 PNG 再上传。
    // 一次性消灭两类面板失败：>8MB 大图（413）与 PNG/JPG 之外的格式（webp/bmp 等）。
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    const fail = (msg) => { URL.revokeObjectURL(objectUrl); setPickedInfo(''); setError(msg) }
    img.onload = () => {
      const w0 = img.naturalWidth
      const h0 = img.naturalHeight
      if (!w0 || !h0) return fail('图片宽高为 0，文件可能损坏。换一张试试。')
      URL.revokeObjectURL(objectUrl)
      try {
        const MAX_EDGE = 1500
        const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0))
        const w = Math.max(1, Math.round(w0 * scale))
        const h = Math.max(1, Math.round(h0 * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, w, h)
        setImageUrl(canvas.toDataURL('image/png'))
        setPickedInfo(`已就绪：${file.name}（${w0}×${h0}${scale < 1 ? ` → 已缩放 ${w}×${h}` : ''}）`)
      } catch (e) {
        setError('图片处理失败：' + (e?.message || e))
      }
    }
    img.onerror = () => fail('浏览器无法解码这张图。HEIC（iPhone 原图）等格式请先用系统相册/画图转成 PNG 或 JPG 再上传。')
    img.src = objectUrl
  }

  return h('div', { style: styles.wrap },
    h('style', null, '@keyframes perler-pop{0%{transform:scale(0.8);opacity:0}60%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}'),
    // 顶部：新建（上传图片 / 图片直链）+ AI 风格化
    h('div', { style: styles.card },
      h('div', { style: styles.row },
        h('label', { style: styles.upload },
          h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: onPickFile }),
          '选择图片'),
        h('input', {
          placeholder: '或粘贴图片直链（http…）', value: imageUrl && !imageUrl.startsWith('data:') ? imageUrl : '',
          onChange: (e) => setImageUrl(e.target.value), style: { ...styles.input, flex: 1 },
        }),
        h('input', { placeholder: '项目名（可留空自动命名）', value: projectName, onChange: (e) => setProjectName(e.target.value), style: styles.input }),
        h('button', { style: styles.buttonSecondary, onClick: () => convert(true), disabled: converting || optimizing || !imageUrl },
          optimizing ? `AI 风格化中 ${optimizeSeconds}s…` : 'AI 风格化生成'),
        h('button', { style: styles.button, onClick: () => convert(false), disabled: converting || optimizing || !imageUrl }, converting && !optimizing ? '转换中…' : '生成拼豆图'),
        h('button', {
          style: showSettings ? styles.buttonSecondary : styles.upload,
          onClick: () => setShowSettings((v) => !v),
          title: '配置火山 AK/SK，启用 AI 风格化',
        }, '⚙️ AI 密钥')),
      aiReady === false && !showSettings ? h('div', { style: styles.muted }, '提示：点右上角「⚙️ AI 密钥」粘贴火山 AK/SK 即可用「AI 风格化生成」，把普通图变成适合拼豆的 Q 版像素风。') : null,
      showSettings ? h(SettingsPanel) : null,
      pickedInfo ? h('div', { style: styles.row },
        imageUrl && imageUrl.startsWith('data:')
          ? h('img', { src: imageUrl, style: styles.pickPreview, alt: '所选图片预览' })
          : null,
        h('div', { style: styles.muted }, pickedInfo)) : null,
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

      // 右：详情（或专心拼豆模式）
      h('div', { style: { ...styles.card, flex: 1, minHeight: 300 } },
        !selected ? h('div', { style: styles.muted }, '← 选一个项目，或先转换一张图')
          : detail === null ? h('div', { style: styles.muted }, '加载中…')
            : focusMode && detail.pixelData
              ? h(FocusMode, { detail, system, onExit: () => setFocusMode(false) })
              : h('div', null,
              h('div', { style: styles.row },
                h('div', { style: styles.sectionTitle }, `${detail.meta.title || detail.meta.name}（${detail.gridDimensions.cols}×${detail.gridDimensions.rows}）`),
                detail.meta.removedCells
                  ? h('span', { style: styles.mutedSmall }, `已去背景 ${detail.meta.removedCells} 格（${Math.round((detail.meta.removedRatio || 0) * 100)}%）`)
                  : null,
                h('select', { value: system, onChange: (e) => setSystem(e.target.value), style: styles.input, title: '色号系统（切换即时生效）' },
                  SYSTEMS.map((s) => h('option', { key: s, value: s }, s))),
                h('select', { value: reconvertSize, onChange: (e) => setReconvertSize(Number(e.target.value)), style: styles.input, title: '格子数（横向）' },
                  [16, 24, 32, 40, 50, 64, 80, 100, 128].map((n) => h('option', { key: n, value: n }, `${n} 格`))),
                h('button', {
                  style: styles.buttonSecondary,
                  disabled: reconverting || Number(reconvertSize) === Number(detail.gridDimensions.cols),
                  onClick: async () => {
                    setReconverting(true); setError('')
                    try {
                      await fetchJson('/api/reconvert', { name: selected, granularity: reconvertSize, system })
                      const d = await fetchJson(`/api/project?name=${encodeURIComponent(selected)}`)
                      setDetail(d); loadProjects()
                    } catch (e) { setError(e.message) } finally { setReconverting(false) }
                  },
                }, reconverting ? '重转中…' : '🔄 按此尺寸重转'),
                h('button', { style: styles.buttonSecondary, onClick: () => setFocusMode(true), disabled: !detail.pixelData }, '🧩 专心拼豆'),
                h('button', { style: styles.button, onClick: downloadPng }, '下载图纸 PNG'),
                h('a', { href: `${BASE}/${selected}/beads.svg`, download: `beads-${selected}.svg`, style: styles.button }, 'SVG'),
                h('a', { href: `${BASE}/${selected}/beads.csv`, download: `beads-${selected}.csv`, style: styles.button }, 'CSV')),
              h('div', { style: styles.preview },
                h(LivePreview, { detail, system })),
              h('div', { style: styles.mutedSmall, textAlign: 'center', marginTop: 4 },
                '预览实时响应色号系统切换；「下载图纸 PNG」含采购清单，SVG 为矢量原图'),
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
  settingsField: { marginBottom: 8 },
  ok: { color: '#1a7f37', marginTop: 6 },
  pickPreview: { width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #e3e3e6' },
  mutedSmall: { color: '#a0a0a8', fontSize: 12 },
  wrap: { padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box', fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif', fontSize: 13, color: '#1a1a1a' },
  card: { background: '#ffffff', border: '1px solid #e3e3e6', borderRadius: 10, padding: 12, marginBottom: 12 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 },
  input: { padding: '6px 10px', border: '1px solid #d9d9de', borderRadius: 8, background: '#fff', color: '#1a1a1a', outline: 'none' },
  button: { padding: '6px 14px', border: 'none', borderRadius: 8, background: '#e8734a', color: '#fff', cursor: 'pointer', textDecoration: 'none', fontSize: 13, display: 'inline-block' },
  buttonSecondary: { padding: '6px 14px', border: '1px solid #d9d9de', borderRadius: 8, background: '#f0f0f2', color: '#1a1a1a', cursor: 'pointer', fontSize: 13 },
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
  celebrate: { marginTop: 12, padding: '16px', borderRadius: 12, background: 'linear-gradient(90deg,#ffe08a,#ffb3a7)', color: '#7a3b1e', fontWeight: 700, fontSize: 16, textAlign: 'center', animation: 'perler-pop 0.6s ease' },
}

function apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: () => '拼豆工坊' }, StudioIcon))
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, StudioPanel))
}

// ============================================================================
// 专心拼豆模式：选一种颜色 → 按连通域引导（最近/大块优先）→ 点格子打卡 → 全部完成庆祝。
// 连通域逻辑来自 lib/regions.js（移植自原项目 floodFillUtils.ts）。
// ============================================================================
function FocusMode({ detail, system, onExit }) {
  const { pixelData, gridDimensions } = detail
  const cols = gridDimensions.cols
  const rows = gridDimensions.rows
  const stats = computeStats(pixelData)
  const CELL = cols > 90 ? 18 : cols > 60 ? 24 : 30

  const [colorIdx, setColorIdx] = useState(0) // 在 stats.list 中的序号
  const [guidance, setGuidance] = useState('nearest') // nearest | largest
  const [completed, setCompleted] = useState(() => new Set())
  const [lastCell, setLastCell] = useState({ row: Math.floor(rows / 2), col: Math.floor(cols / 2) })
  const canvasRef = useRef(null)

  const currentColor = stats.list[colorIdx]?.hex
  const regions = currentColor ? getAllConnectedRegions(pixelData, currentColor) : []
  const sorted = guidance === 'largest'
    ? sortRegionsBySize(regions)
    : sortRegionsByDistance(regions, lastCell)
  const currentRegion = sorted.find((region) => !isRegionCompleted(region, completed)) || null
  const currentSet = currentRegion ? new Set(currentRegion.map(({ row, col }) => `${row},${col}`)) : new Set()
  const colorTotal = stats.list[colorIdx]?.count || 0
  const colorDone = [...completed].filter((key) => pixelData[Number(key.split(',')[0])][Number(key.split(',')[1])]?.color === currentColor).length
  const allDone = stats.total > 0 && [...completed].filter((key) => {
    const [r, c] = key.split(',').map(Number)
    const cell = pixelData[r]?.[c]
    return cell && !cell.isExternal && cell.key !== ERASE
  }).length >= stats.total

  const toggleCell = (row, col) => {
    const cell = pixelData[row]?.[col]
    if (!cell || cell.isExternal || cell.key === ERASE) return
    if (cell.color !== currentColor) return
    setLastCell({ row, col })
    setCompleted((prev) => {
      const next = new Set(prev)
      const key = `${row},${col}`
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 渲染画布
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = cols * CELL
    canvas.height = rows * CELL
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fafafa'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = pixelData[r][c]
        const x = c * CELL
        const y = r * CELL
        const key = `${r},${c}`
        const blank = !cell || cell.isExternal || cell.key === ERASE
        if (blank) {
          ctx.fillStyle = '#f1f1f1'
          ctx.fillRect(x, y, CELL, CELL)
          continue
        }
        if (cell.color === currentColor) {
          if (completed.has(key)) {
            ctx.fillStyle = cell.color // 已拼：实体色
            ctx.fillRect(x, y, CELL, CELL)
          } else if (currentSet.has(key)) {
            ctx.fillStyle = '#ffffff' // 当前引导区：白底 + 色描边
            ctx.fillRect(x, y, CELL, CELL)
            ctx.strokeStyle = cell.color
            ctx.lineWidth = 2
            ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3)
          } else {
            ctx.fillStyle = '#e8e8ec' // 同色但还不是当前引导域
            ctx.fillRect(x, y, CELL, CELL)
            ctx.strokeStyle = '#d5d5da'
            ctx.lineWidth = 1
            ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1)
          }
        } else {
          // 其他颜色：淡色提示
          ctx.fillStyle = cell.color
          ctx.globalAlpha = 0.13
          ctx.fillRect(x, y, CELL, CELL)
          ctx.globalAlpha = 1
        }
      }
    }
    // 网格线
    ctx.strokeStyle = '#e0e0e0'
    ctx.lineWidth = 0.5
    for (let c = 0; c <= cols; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, canvas.height); ctx.stroke() }
    for (let r = 0; r <= rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(canvas.width, r * CELL); ctx.stroke() }
  }, [pixelData, currentColor, completed, currentSet, cols, rows, CELL])

  const onCanvasClick = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const hit = clientToGrid(canvas.getBoundingClientRect(), canvas.width, canvas.height, CELL, event.clientX, event.clientY)
    if (hit && hit.row >= 0 && hit.row < rows && hit.col >= 0 && hit.col < cols) toggleCell(hit.row, hit.col)
  }

  const pickColor = (idx) => {
    setColorIdx(idx)
    setLastCell({ row: Math.floor(rows / 2), col: Math.floor(cols / 2) })
  }

  return h('div', null,
    h('div', { style: styles.row },
      h('button', { style: styles.buttonSecondary, onClick: onExit }, '← 返回'),
      h('select', {
        value: colorIdx, onChange: (e) => pickColor(Number(e.target.value)), style: styles.input,
      },
        stats.list.map((item, idx) => h('option', { key: item.hex, value: idx }, `${codeOf(item.hex, system)} ${item.hex} × ${item.count}`))),
      h('button', { style: styles.buttonSecondary, onClick: () => setGuidance(guidance === 'nearest' ? 'largest' : 'nearest') },
        guidance === 'nearest' ? '引导：最近优先' : '引导：大块优先'),
      h('span', { style: styles.muted }, `当前色进度 ${colorDone}/${colorTotal}`),
      h('button', { style: styles.buttonSecondary, onClick: () => setCompleted(new Set()) }, '重置')),
    h('div', { style: styles.preview },
      h('canvas', { ref: canvasRef, onClick: onCanvasClick, style: { maxWidth: '100%', cursor: 'pointer' } })),
    h('div', { style: { ...styles.muted, marginTop: 8 } }, '点击当前色描边格子打卡（再点取消）。全部拼完有庆祝 🎉'),
    allDone ? h('div', { style: styles.celebrate }, '🎉 全部完成！这部作品拼好啦 🎉') : null)
}

exports.isPlugin = true
exports.inject = ['slots']
exports.apply = apply
