// 离线自检：程序化生成测试 PNG → 转换全链路 → 校验产物。不依赖 dsh、不花任何积分。
// 运行：node scripts/selftest.mjs
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME 必须在 import 模块代码之前设置
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'perler-selftest-'))

const { PNG } = await import('pngjs')
const { encodePng } = await import('../lib/decode.js')
const { convertFlow, readFlow, shoppingListFlow } = await import('../lib/flows.js')
const { toCsv, fromCsv } = await import('../lib/exporter.js')

let failed = 0
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `)
  try {
    await fn()
    console.log('ok')
  } catch (err) {
    failed++
    console.log('失败')
    console.error(`  ${err.message}`)
  }
}

// 生成一张 64×32 测试图：四周 8px 白框（边缘主导 → 判定为背景），中间上红下蓝（主体保留）
function makeTestPng() {
  const width = 64
  const height = 32
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let rgb
      const inFrame = x < 8 || x >= width - 8 || y < 5 || y >= height - 5
      if (inFrame) rgb = [250, 250, 250]
      else if (y < height / 2) rgb = [227, 50, 40]
      else rgb = [23, 120, 200]
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255
    }
  }
  return encodePng({ width, height, data })
}

const pngBuffer = makeTestPng()
const dataUri = `data:image/png;base64,${pngBuffer.toString('base64')}`

let out
await step('转换（dataURI → 项目）', async () => {
  out = await convertFlow({ name: 'selftest-样片', image: dataUri, granularity: 32, system: 'MARD' })
  if (!out.meta.grid || out.meta.grid.cols !== 32) throw new Error(`网格列数应为 32，实际 ${out.meta.grid?.cols}`)
})
await step('产物齐备（pattern/svg/csv/source）', () => {
  for (const file of ['pattern.json', 'beads.svg', 'beads.csv', 'source.png', 'project.json']) {
    const path = join(out.dir, file)
    if (!existsSync(path)) throw new Error(`缺产物：${file}`)
  }
})
await step('去背景生效（白框被移除）', () => {
  if (!out.removedBackgroundKey) throw new Error('未判定出背景色')
  const { pixelData } = readFlow('selftest-样片')
  const corner = pixelData[0][0]
  const center = pixelData[Math.floor(pixelData.length / 2)][Math.floor(pixelData[0].length / 2)]
  if (!(corner.isExternal || corner.key === 'ERASE')) throw new Error('白框角未被标记外部')
  if (center.isExternal || center.key === 'ERASE') throw new Error('中心主体被误删')
})
await step('统计合理（红蓝两主色 + 总数）', () => {
  const colors = Object.keys(out.colorCounts)
  if (colors.length < 2 || colors.length > 4) throw new Error(`颜色数异常：${colors.length}（${colors.join(',')}）`)
  if (out.totalBeads <= 0) throw new Error('总数为 0')
})
await step('SVG 含色号文字与统计区', () => {
  const svg = readFileSync(join(out.dir, 'beads.svg'), 'utf8')
  if (!svg.includes('<svg') || !svg.includes('采购清单')) throw new Error('SVG 结构不完整')
})
await step('CSV 往返一致', () => {
  const csv = readFileSync(join(out.dir, 'beads.csv'), 'utf8')
  const back = fromCsv(csv)
  const original = readFlow('selftest-样片').pixelData
  if (back.length !== original.length || back[0].length !== original[0].length) throw new Error('CSV 回读尺寸不一致')
  for (let r = 0; r < original.length; r++) {
    for (let c = 0; c < original[0].length; c++) {
      const a = original[r][c]
      const b = back[r][c]
      const aBlank = a.isExternal || a.key === 'ERASE'
      const bBlank = b.isExternal || b.key === 'ERASE'
      if (aBlank !== bBlank || (!aBlank && a.color !== b.color)) throw new Error(`CSV 往返不一致 @${r},${c}`)
    }
  }
})
await step('采购清单（色号映射）', async () => {
  const list = await shoppingListFlow('selftest-样片', 'MARD')
  if (!list.length) throw new Error('采购清单为空')
  if (list.some((item) => !item.code || item.code === '?')) throw new Error(`存在查不到色号的条目：${JSON.stringify(list[0])}`)
})
await step('内网来源报可读错误（SSRF 防护）', async () => {
  try {
    await convertFlow({ name: 'selftest-bad', image: 'http://127.0.0.1:9/x.png' })
    throw new Error('不应成功')
  } catch (err) {
    if (!/拒绝访问内网|下载失败/.test(err.message)) throw new Error(`错误信息不明确：${err.message}`)
  }
})

if (failed > 0) {
  console.error(`\n自检失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n全部通过。')
