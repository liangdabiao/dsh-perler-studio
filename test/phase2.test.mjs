// 二期测试：火山即梦封装（jimeng.js）、AI 风格化流程（optimizeFlow）、连通域（regions.js）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'perler-phase2-'))

const { generateSignature, submitTask, waitForTaskCompletion, ImageRiskError, JimengError, DEFAULT_PROMPT } = await import('../lib/jimeng.js')
const { optimizeFlow } = await import('../lib/flows.js')
const {
  getConnectedRegion, getAllConnectedRegions, isRegionCompleted, isRegionPartiallyCompleted,
  getRegionCenter, sortRegionsByDistance, sortRegionsBySize, clientToGrid,
} = await import('../lib/regions.js')
const { encodePng } = await import('../lib/decode.js')

// ---------- jimeng 签名 ----------
test('V4 签名结构与常量', async () => {
  const authorization = await generateSignature({
    method: 'POST', pathName: '/', query: { Action: 'CVSync2AsyncSubmitTask', Version: '2022-08-31' },
    headers: { host: 'visual.volcengineapi.com', 'X-Date': '20261107T010101Z', 'content-type': 'application/json' },
    bodySha: 'abc',
    accessKeyId: 'AKLTtest', secretAccessKey: 'SKtest',
  })
  assert.match(authorization, /^HMAC-SHA256 Credential=AKLTtest\/20261107\/cn-north-1\/cv\/request, /)
  assert.match(authorization, /SignedHeaders=host;x-date, /, 'content-type 在忽略清单里（与源实现一致）')
  assert.match(authorization, /Signature=[0-9a-f]{64}$/)
})

test('签名对相同输入确定性一致、不同密钥结果不同', async () => {
  const base = {
    method: 'POST', pathName: '/', query: { Action: 'A', Version: '1' },
    headers: { host: 'visual.volcengineapi.com', 'X-Date': '20261107T010101Z', 'content-type': 'application/json' },
    bodySha: 'abc',
  }
  const a = await generateSignature({ ...base, accessKeyId: 'AK1', secretAccessKey: 'SK1' })
  const a2 = await generateSignature({ ...base, accessKeyId: 'AK1', secretAccessKey: 'SK1' })
  const b = await generateSignature({ ...base, accessKeyId: 'AK1', secretAccessKey: 'SK2' })
  assert.equal(a, a2)
  assert.notEqual(a, b)
})

// fetch 注入：模拟提交/轮询
function fakeFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    const response = responses[Math.min(calls.length - 1, responses.length - 1)]
    return { ok: true, status: 200, text: async () => JSON.stringify(response) }
  }
  return { impl, calls }
}

const CONFIG = { volcAccessKeyId: 'AK', volcSecretAccessKey: 'SK' }

test('submitTask：缺 key 给出可操作错误', async () => {
  await assert.rejects(
    () => submitTask({ imageBase64: 'aGk=', prompt: 'p', config: { volcAccessKeyId: '', volcSecretAccessKey: '' } }),
    (err) => err instanceof JimengError && /Configuration/.test(err.message))
})

test('submitTask + waitForTaskCompletion：提交→done→返回图片（注入 fetch）', async () => {
  const { impl, calls } = fakeFetch([
    { status: 10000, data: { task_id: 'T1' } },
    { status: 10000, data: { status: 'in_queue' } },
    { status: 10000, data: { status: 'done', image_urls: ['https://example.com/out.jpeg'] } },
  ])
  const { taskId } = await submitTask({ imageBase64: 'aGk=', prompt: 'p', config: CONFIG, fetchImpl: impl })
  assert.equal(taskId, 'T1')
  assert.equal(calls[0].body.req_key, 'jimeng_t2i_v40')
  assert.equal(calls[0].body.binary_data_base64[0], 'aGk=')
  assert.match(String(calls[0].url), /Action=CVSync2AsyncSubmitTask/)
  const image = await waitForTaskCompletion({ taskId, config: CONFIG, poll: { intervalMs: 1 }, fetchImpl: impl })
  assert.equal(image, 'https://example.com/out.jpeg')
  assert.match(String(calls[1].url), /Action=CVSync2AsyncGetResult/)
  assert.equal(calls[1].body.task_id, 'T1')
})

test('IMAGE_RISK：50411 与 Risk 文案都映射为安全检测错误', async () => {
  const riskByCode = fakeFetch([{ status: 50411, message: 'Output risk content' }])
  await assert.rejects(() => submitTask({ imageBase64: 'aGk=', prompt: 'p', config: CONFIG, fetchImpl: riskByCode.impl }), ImageRiskError)
  const riskByText = fakeFetch([{ status: 10000, data: { status: 'failed' } }].map((x) => ({ ...x, message: 'I have detected Risk content' })))
  // failed 分支在轮询里触发
  await assert.rejects(
    () => waitForTaskCompletion({ taskId: 'T', config: CONFIG, poll: { intervalMs: 1 }, fetchImpl: riskByText.impl }),
    ImageRiskError)
})

test('轮询超时给出可读错误', async () => {
  const neverDone = fakeFetch([{ status: 10000, data: { status: 'generating' } }])
  await assert.rejects(
    () => waitForTaskCompletion({ taskId: 'T', config: CONFIG, poll: { maxAttempts: 2, intervalMs: 1 }, fetchImpl: neverDone.impl }),
    /任务超时/)
})

test('DEFAULT_PROMPT 与源项目一致', () => {
  assert.match(DEFAULT_PROMPT, /chibi/)
  assert.match(DEFAULT_PROMPT, /pixel art style/)
})

// ---------- optimizeFlow（注入 jimeng 实现） ----------
test('optimizeFlow：无 key 优雅报错', async () => {
  await assert.rejects(() => optimizeFlow({ name: 'x', volcAccessKeyId: '', volcSecretAccessKey: '' }), /AK\/SK|Configuration/)
})

test('optimizeFlow：提交→风格化图落盘→自动重转（注入 jimeng + dataURI 产物）', async () => {
  const png = encodePng(solidImage(16, 8, { r: 200, g: 80, b: 60 }))
  const dataUri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
  const outPng = encodePng(solidImage(16, 8, { r: 60, g: 120, b: 200 }))
  const jimengImpl = {
    submitTask: async () => ({ taskId: 'T9' }),
    waitForTaskCompletion: async () => `data:image/png;base64,${Buffer.from(outPng).toString('base64')}`,
  }
  const out = await optimizeFlow({
    name: 'phase2-样例', imageDataUri: dataUri, granularity: 8, system: 'COCO',
    volcAccessKeyId: 'AK', volcSecretAccessKey: 'SK',
  }, jimengImpl)
  assert.equal(out.converted, true)
  assert.equal(out.meta.aiOptimized, true)
  assert.ok(out.totalBeads > 0)
  assert.match(out.aiImage, /ai-optimized\.png$/)
  // 项目元数据里不应出现密钥
  const { readFileSync } = await import('node:fs')
  const meta = readFileSync(join(process.env.DSH_HOME, 'perler-studio', 'phase2-样例', 'project.json'), 'utf8')
  assert.ok(!meta.includes('AK'), '元数据不应含密钥痕迹')
})

function solidImage(width, height, rgb) {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb.r; data[i * 4 + 1] = rgb.g; data[i * 4 + 2] = rgb.b; data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

// ---------- 连通域（regions） ----------
const GRID = [
  [cell('#FF0000'), cell('#FF0000'), cell('#00FF00')],
  [cell('#FF0000'), cell('#FFFFFF'), cell('#00FF00')],
  [cell('#0000FF'), cell('#FFFFFF'), cell('#00FF00')],
]
function cell(color) { return { key: color, color } }

test('getConnectedRegion：4 邻域不穿墙', () => {
  const region = getConnectedRegion(GRID, 0, 0, '#FF0000')
  assert.equal(region.length, 3) // 左上角的 L 形红色
  const keys = region.map(({ row, col }) => `${row},${col}`).sort()
  assert.deepEqual(keys, ['0,0', '0,1', '1,0'])
})

test('getAllConnectedRegions：同色分离域分别统计', () => {
  const regions = getAllConnectedRegions(GRID, '#00FF00')
  assert.equal(regions.length, 1)
  assert.equal(regions[0].length, 3)
  // 两个不相邻的白色格 → 2 个独立域
  const scattered = [[cell('#FFFFFF'), cell('#000000'), cell('#FFFFFF')]]
  assert.equal(getAllConnectedRegions(scattered, '#FFFFFF').length, 2)
})

test('外部/擦除格不参与连通域', () => {
  const g = [[cell('#FF0000'), { key: 'ERASE', color: '#FFFFFF', isExternal: true }]]
  assert.equal(getAllConnectedRegions(g, '#FF0000').length, 1)
})

test('isRegionCompleted / Partially', () => {
  const region = [{ row: 0, col: 0 }, { row: 0, col: 1 }]
  assert.equal(isRegionCompleted(region, new Set(['0,0', '0,1'])), true)
  assert.equal(isRegionCompleted(region, new Set(['0,0'])), false)
  assert.equal(isRegionPartiallyCompleted(region, new Set(['0,0'])), true)
})

test('区域中心与排序（最近/大块）', () => {
  const big = [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }]
  const small = [{ row: 2, col: 2 }]
  assert.deepEqual(getRegionCenter(big), { row: 0, col: 0 })
  assert.deepEqual(getRegionCenter(small), { row: 2, col: 2 })
  assert.equal(sortRegionsBySize([small, big])[0], big)
  const byDistance = sortRegionsByDistance([small, big], { row: 0, col: 0 })
  assert.equal(byDistance[0], big)
})

test('clientToGrid：缩放显示下点击坐标仍映射到正确格子', () => {
  // 画布内部 1200×600（格 30px），显示被压到 668×334：点击显示坐标 (15.5*30)*0.5567 处应得 (2,15)
  const rect = { left: 572, top: 174, width: 668, height: 334 }
  const canvasWidth = 1200, canvasHeight = 600, CELL = 30
  const hit = clientToGrid(rect, canvasWidth, canvasHeight, CELL, 714.6, 315.9) // (8,8) 格中心附近
  assert.deepEqual(hit, { row: 8, col: 8 })
  const hit2 = clientToGrid(rect, canvasWidth, canvasHeight, CELL, rect.left + 15.5 * CELL * (rect.width / canvasWidth), rect.top + 2.5 * CELL * (rect.height / canvasHeight))
  assert.deepEqual(hit2, { row: 2, col: 15 })
  assert.equal(clientToGrid({ left: 0, top: 0, width: 0, height: 0 }, 100, 100, 30, 5, 5), null, '零尺寸安全')
})
