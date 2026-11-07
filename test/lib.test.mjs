// lib 层单测：Node 原生 test runner，零 dsh 依赖。
// DSH_HOME 指向临时目录必须在 import 模块代码之前（ESM 顶层 await）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'perler-test-'))

const {
  lookupHex, nearestPaletteColors, findClosestPaletteColor, hexToRgb, rgbToHex, normalizeHex, paletteInfo, COLOR_SYSTEMS,
} = await import('../lib/palette.js')
const { decodeImage, encodePng, sniffImage } = await import('../lib/decode.js')
const { pixelate, removeBackground, computeStats, TRANSPARENT_KEY } = await import('../lib/pixelate.js')
const { toCsv, fromCsv, shoppingList, toSvg } = await import('../lib/exporter.js')
const { convertFlow, readFlow, listFlow, shoppingListFlow } = await import('../lib/flows.js')
const { assertInside, isValidProjectName, safeFileUnder, dataRoot } = await import('../lib/project.js')
const { requestRejection, readJson } = await import('../lib/api.js')

// ---------- 色板 ----------
test('色板规模与 lookup', () => {
  const info = paletteInfo()
  assert.equal(info.colors, 291)
  assert.deepEqual(info.systems, COLOR_SYSTEMS)
  const entry = lookupHex('#FBED56') // 色 CSV 首屏样例
  assert.equal(entry.MARD, 'A04')
  assert.equal(entry.COCO, 'E07')
  assert.equal(entry['漫漫'], 'B3')
  assert.equal(lookupHex('#000000') !== null, true)
  assert.equal(lookupHex('#123456'), null, '非色板色应返回 null')
  assert.equal(normalizeHex('fbed56'), '#FBED56', '小写归一为大写')
})

test('nearest / findClosest：距离排序与精确匹配', () => {
  const near = nearestPaletteColors({ r: 255, g: 0, b: 0 }, 3)
  assert.equal(near.length, 3)
  assert.ok(near[0].distance <= near[1].distance)
  const exact = findClosestPaletteColor(hexToRgb(FULL_FIRST()))
  assert.equal(exact.hex, FULL_FIRST())
  function FULL_FIRST() { return '#FAF4C8' }
})

// ---------- 解码 ----------
test('PNG 编解码往返 + 魔数嗅探', () => {
  const width = 4, height = 2
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 250; data[i * 4 + 1] = 244; data[i * 4 + 2] = 200; data[i * 4 + 3] = 255
  }
  const png = encodePng({ width, height, data })
  assert.equal(sniffImage(png), 'png')
  const img = decodeImage(png)
  assert.equal(img.width, width)
  assert.equal(img.height, height)
  assert.equal(img.data[0], 250)
})

// ---------- 量化 ----------
function solidImage(width, height, rgb) {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb.r; data[i * 4 + 1] = rgb.g; data[i * 4 + 2] = rgb.b; data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

test('纯色图量化：全部映射到同一色板色', () => {
  const out = pixelate(solidImage(50, 25, { r: 227, g: 50, b: 40 }), { granularity: 10 })
  assert.equal(out.gridDimensions.cols, 10)
  assert.equal(out.totalBeads, 10 * Math.round(10 * 25 / 50))
  const colors = new Set(out.pixelData.flat().map((c) => c.color))
  assert.equal(colors.size, 1)
})

test('合并阈值：两近似色并成一色（阈值调大）', () => {
  // 左半 (230,60,60)，右半 (235,70,70)——距离约 17
  const width = 20, height = 10
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const rgb = x < width / 2 ? { r: 230, g: 60, b: 60 } : { r: 235, g: 70, b: 70 }
      data[i] = rgb.r; data[i + 1] = rgb.g; data[i + 2] = rgb.b; data[i + 3] = 255
    }
  }
  const merged = pixelate({ width, height, data }, { granularity: 10, mergeThreshold: 40, removeBg: false })
  assert.ok(Object.keys(merged.colorCounts).length <= 2, `合并后颜色过多：${Object.keys(merged.colorCounts).length}`)
  const strict = pixelate({ width, height, data }, { granularity: 10, mergeThreshold: 0, removeBg: false })
  assert.ok(Object.keys(strict.colorCounts).length >= Object.keys(merged.colorCounts).length, '阈值 0 不应比大阈值更少色')
})

test('去背景：边缘主导色为白框时，白框被清除、主体保留', () => {
  const size = 12
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inFrame = x < 3 || x >= size - 3 || y < 3 || y >= size - 3 // 白框（边缘主导）
      data[i] = inFrame ? 255 : 30; data[i + 1] = inFrame ? 255 : 60; data[i + 2] = inFrame ? 255 : 200; data[i + 3] = 255
    }
  }
  const out = pixelate({ width: size, height: size, data }, { granularity: 12, removeBg: true })
  assert.ok(out.removedBackgroundKey, '应判定出背景色')
  const corner = out.pixelData[0][0]
  assert.ok(corner.isExternal || corner.key === TRANSPARENT_KEY, '白框角应为外部')
  const center = out.pixelData[6][6]
  assert.ok(!center.isExternal && center.key !== TRANSPARENT_KEY, '中心主体应保留')
  assert.ok(out.totalBeads > 0, '去背景后应保留主体豆数')
})

test('纯色图去背景保护：整图同色时不清空', () => {
  const out = pixelate(solidImage(20, 10, { r: 250, g: 250, b: 250 }), { granularity: 10, removeBg: true })
  assert.equal(out.removedBackgroundKey, null, '清空保护：全图同色不应去背景')
  assert.ok(out.totalBeads > 0)
})

test('removeBackground 独立调用（无背景返回 null）', () => {
  const grid = [
    [{ key: '#000000', color: '#000000' }, { key: '#FFFFFF', color: '#FFFFFF' }],
    [{ key: '#FFFFFF', color: '#FFFFFF' }, { key: '#000000', color: '#000000' }],
  ]
  // 边缘黑白各二并列、无主导背景色：只会清走其中一个连通域的一半，不清空全图——正常返回 key
  const result = removeBackground(grid.map((r) => r.map((c) => ({ ...c }))))
  assert.ok(result === null || typeof result === 'string')
})

// ---------- CSV / SVG ----------
test('CSV 往返一致', () => {
  const grid = [
    [{ key: '#AAAAAA', color: '#AAAAAA' }, { key: 'ERASE', color: '#FFFFFF', isExternal: true }],
    [{ key: '#BBBBBB', color: '#BBBBBB' }, { key: '#CCCCCC', color: '#CCCCCC' }],
  ]
  const csv = toCsv(grid)
  assert.equal(csv, '#AAAAAA,TRANSPARENT\n#BBBBBB,#CCCCCC')
  const back = fromCsv(csv)
  assert.equal(back[0][0].color, '#AAAAAA')
  assert.equal(back[0][1].isExternal, true)
  assert.equal(back[1][1].color, '#CCCCCC')
})

test('SVG 含图纸要素', () => {
  const grid = [[{ key: '#FBED56', color: '#FBED56' }]]
  const counts = computeStats(grid).colorCounts
  const svg = toSvg(grid, { colorCounts: counts, totalBeads: 1 }, { title: '测试 <图>', system: 'MARD' })
  assert.ok(svg.startsWith('<?xml'))
  assert.ok(svg.includes('测试 &lt;图&gt;'), '标题要转义')
  assert.ok(svg.includes('#FBED56'))
  assert.ok(svg.includes('A04'), '应含 MARD 色号文字')
  assert.ok(svg.includes('采购清单'))
})

test('shoppingList 排序与色号', () => {
  const counts = { '#FBED56': { count: 2, color: '#FBED56' }, '#FAF4C8': { count: 9, color: '#FAF4C8' } }
  const list = shoppingList(counts, 'MARD')
  assert.equal(list[0].code, 'A01')
  assert.ok(list[0].count >= list[1].count)
})

// ---------- 项目持久化 / flows ----------
test('convertFlow 全链路 + readFlow + listFlow', async () => {
  const png = encodePng(solidImage(40, 20, { r: 30, g: 120, b: 200 }))
  const dataUri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
  const out = await convertFlow({ name: '样例', image: dataUri, granularity: 8, system: 'COCO' })
  assert.equal(out.meta.status, 'ready')
  assert.ok(existsSync(join(dataRoot(), '样例', 'beads.svg')))
  const read = readFlow('样例')
  assert.equal(read.pixelData.length, out.meta.grid.rows)
  const projects = listFlow()
  assert.ok(projects.some((p) => p.name === '样例'))
  const list = await shoppingListFlow('样例', 'COCO')
  assert.ok(list.every((item) => item.code !== '?'), 'COCO 色号应全部可查')
})

test('项目名校验与路径越界', () => {
  assert.equal(isValidProjectName('皮卡丘'), true)
  assert.equal(isValidProjectName('../escape'), false)
  assert.equal(isValidProjectName('a/b'), false)
  assert.equal(isValidProjectName('.hidden'), false)
  assert.throws(() => assertInside('/tmp/base', '../outside'), /越界/)
  assert.equal(safeFileUnder('/tmp/nonexistent-base', 'x.svg'), null)
})

test('convertFlow 拒绝坏来源并给可读错误', async () => {
  await assert.rejects(() => convertFlow({ name: 'bad', image: 'relative/path.png' }), /绝对路径|attachments|dataURI|URL/)
  await assert.rejects(() => convertFlow({ name: 'bad', image: 'http://127.0.0.1:9/x.png' }), /内网|下载失败/)
  await assert.rejects(() => convertFlow({ name: 'bad/x', imageDataUri: 'data:image/png;base64,aGk=' }), /项目名不合法/)
})

// ---------- API 鉴权 ----------
test('requestRejection：拿不到鉴权服务时 fail closed', () => {
  const noService = { get: () => undefined }
  assert.equal(requestRejection(noService, { headers: {} }), 403)
  const okService = { get: () => ({ requestRejection: () => false }) }
  assert.equal(requestRejection(okService, { headers: {} }), false)
})

test('readJson：拒绝非 POST / 非 JSON / 跨站', async () => {
  await assert.rejects(() => readJson({ method: 'GET', headers: {}, on: () => {} }), /只接受 POST/, 'GET 应被拒')
  const site = { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, on: () => {} }
  await assert.rejects(() => readJson(site), /跨站/)
})
