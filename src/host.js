// ============================================================================
// 拼豆工坊 · Host 半边（Node 主进程，纯 ESM 零构建）。
// 工具：perler_studio（转换/AI 风格化/读取/列项目/采购清单）、perler_palette（色号查询）。
// webServer 前缀路由：面板数据面（与工具共用 lib/flows.js，一份逻辑两个入口）。
// AI 风格化 = 火山即梦 4.0（lib/jimeng.js）；AK/SK 走 Config，绝不硬编码、绝不回显。
// ============================================================================
import Schema from '@deepseek-ai/schemastery'
import { convertFlow, readFlow, listFlow, shoppingListFlow, reconvertFlow, optimizeFlow, ImageSourceError, JimengError } from '../lib/flows.js'
import { computeStats } from '../lib/pixelate.js'
import { shoppingList as makeShoppingList } from '../lib/exporter.js'
import { lookupHex, nearestPaletteColors, hexToRgb, rgbToHex, paletteInfo, COLOR_SYSTEMS } from '../lib/palette.js'
import { registerApi } from '../lib/api.js'

export const name = 'perler-studio' // = cordis.patch.yml 的 id

export const inject = ['tools', 'webServer', 'connection']

// ---------------------------------------------------------------------------
// 用户配置。volcAccessKeyId / volcSecretAccessKey 是火山引擎即梦 4.0 的凭证
// （https://console.volcengine.com/ai/ability/detail/1 申请）；留空 = AI 风格化不可用，
// 其余功能不受影响。密钥只在工具/面板内部使用，任何回执与接口都不会返回它。
// ---------------------------------------------------------------------------
export const Config = Schema.object({
  defaultGranularity: Schema.number().min(5).max(200).default(50).description('默认横向格子数'),
  defaultSystem: Schema.string().default('MARD').description('默认色号系统'),
  volcAccessKeyId: Schema.string().default('').description('火山引擎 AccessKeyId（即梦 4.0 图生图，可选）'),
  volcSecretAccessKey: Schema.string().default('').description('火山引擎 SecretAccessKey（敏感，仅本插件使用）'),
})

const configRef = { config: Config }

// 手写参数校验（原生注册工具 dsh 不代验参数）
function check(args, spec) {
  const problems = []
  for (const key of spec.required || []) {
    if (args?.[key] === undefined) problems.push(`缺少必填参数 ${key}`)
  }
  for (const [key, rule] of Object.entries(spec.properties || {})) {
    const value = args?.[key]
    if (value === undefined) continue
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')} 之一`)
  }
  for (const key of Object.keys(args || {})) {
    if (!spec.properties || !(key in spec.properties)) problems.push(`未知参数 ${key}`)
  }
  if (problems.length) throw new Error(`perler_studio 参数有误：${problems.join('；')}。`)
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '可选：采购清单等结构化文本' },
    },
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary),
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

// ---------------------------------------------------------------------------
// 工具 1：perler_studio
// ---------------------------------------------------------------------------
export const perlerStudioTool = {
  name: 'perler_studio',
  description:
    '把图片转成拼豆底稿（图纸/采购清单）。用户想「做拼豆图/转拼豆图纸/拼豆采购清单/查拼豆色号对照」时使用。' +
    'image 支持：本地图片绝对路径、http(s) 图片链接、dataURI，或 "attachments"（用户刚通过上传按钮传的图，优先用这个）。' +
    '产出：beads.svg 图纸、beads.csv 色号矩阵、采购清单；用户可在侧栏「拼豆工坊」面板查看与下载 PNG 图纸。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('convert 转换；optimize AI 风格化后自动重转；read 读项目；list 列项目；shopping 采购清单；reconvert 改参数重转', { enum: ['convert', 'optimize', 'read', 'list', 'shopping', 'reconvert'] }),
      name: str('项目名（即存档目录名）：字母/数字/中文短横线等，不要带路径符或空格'),
      title: str('可选：展示标题'),
      image: str('convert/optimize：图片来源（绝对路径 / http(s) URL / dataURI / "attachments"）。optimize 缺省用项目已有源图'),
      prompt: str('optimize 可选：风格化提示词。缺省用内置的 chibi 像素画风格'),
      thenConvert: str('optimize 可选：风格化后是否自动重转本项目，默认 true', { enum: ['true', 'false'] }),
      granularity: num('convert：横向格子数 5~200，默认 50。颗粒越少越简单，越多越细腻'),
      mode: str('convert：dominant 卡通风（主色）/ average 真实风（均值）', { enum: ['dominant', 'average'] }),
      mergeThreshold: num('convert：近似色合并阈值 0~255，默认 30。越大颜色越少'),
      removeBg: str('convert：是否自动去背景（边界洪水填充），默认 true', { enum: ['true', 'false'] }),
      system: str('色号系统：MARD / COCO / 漫漫 / 盼盼 / 咪小窝', { enum: COLOR_SYSTEMS }),
      limit: num('shopping：只看前 N 色（默认全部）'),
    },
  },
  timeoutMs: 200_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const cfg = configRef.config
    const system = args.system || cfg.defaultSystem
    try {
      if (args.action === 'convert') {
        if (!args.name) throw new Error('convert 需要 name（项目名），例如 "皮卡丘" 拼成 pikachu')
        const out = await convertFlow({
          name: args.name,
          title: args.title,
          image: args.image,
          granularity: args.granularity ?? cfg.defaultGranularity,
          mode: args.mode,
          mergeThreshold: args.mergeThreshold,
          removeBg: args.removeBg !== undefined ? args.removeBg !== 'false' : true,
          system,
        })
        const bg = out.removedBackgroundKey ? `，已去背景（判定的背景色 ${out.removedBackgroundKey}）` : ''
        return result(true,
          `已生成拼豆底稿「${out.meta.title}」：${out.meta.grid.cols}×${out.meta.grid.rows} 格、${out.colorCount || out.meta.colorCount} 色 ${out.totalBeads} 粒${bg}（合并了 ${out.mergedColors} 个近似色）。` +
          `产物在 ${out.dir}：beads.svg（图纸）、beads.csv（色号矩阵）。用户可以在侧栏「拼豆工坊」面板查看并下载 PNG 图纸。`,
          listText(out.shoppingList.slice(0, 20), system))
      }
      if (args.action === 'optimize') {
        if (!args.name) throw new Error('optimize 需要 name（项目名，源图缺省取项目 source.png）')
        const out = await optimizeFlow({
          name: args.name,
          title: args.title,
          image: args.image,
          prompt: args.prompt,
          granularity: args.granularity ?? cfg.defaultGranularity,
          mode: args.mode,
          mergeThreshold: args.mergeThreshold,
          removeBg: args.removeBg !== undefined ? args.removeBg !== 'false' : true,
          system,
          thenConvert: args.thenConvert !== 'false',
          volcAccessKeyId: cfg.volcAccessKeyId,
          volcSecretAccessKey: cfg.volcSecretAccessKey,
        })
        return result(true,
          out.converted
            ? `AI 风格化完成并已重转「${args.name}」：${out.meta.grid.cols}×${out.meta.grid.rows} 格、${out.meta.colorCount} 色 ${out.totalBeads} 粒。风格化图存为 ${out.aiImage}（原图仍是 source.png）。`
            : `AI 风格化完成：${out.aiImage}（未重转，如需转换用 action=convert 的 imagePath 指向它）。用户可在侧栏「拼豆工坊」面板查看。`)
      }
      if (args.action === 'read') {
        const out = readFlow(args.name)
        if (!out.pixelData) throw new Error(`项目还没有图案：${args.name}（先 convert）`)
        return result(true,
          `项目「${args.name}」：${out.gridDimensions.cols}×${out.gridDimensions.rows} 格、${out.meta.colorCount} 色 ${out.meta.totalBeads} 粒（色号体系 ${out.meta.system}）。`,
          listText(shoppingListFrom(out), out.meta.system))
      }
      if (args.action === 'list') {
        const projects = listFlow()
        if (projects.length === 0) {
          // 空状态不是错误
          return result(true, '还没有任何拼豆项目。这不是错误：让用户给一张图片，用 action=convert 开始第一个项目。')
        }
        return result(true, `共 ${projects.length} 个项目：`,
          projects.map((p) => `- ${p.name}（${p.grid ? `${p.grid.cols}×${p.grid.rows}` : '未转换'}，${p.totalBeads ?? 0} 粒，${p.updatedAt?.slice(0, 16) || '?'}）`).join('\n'))
      }
      if (args.action === 'shopping') {
        const list = shoppingListFlow(args.name, system)
        const sliced = typeof args.limit === 'number' ? list.slice(0, args.limit) : list
        return result(true, `「${args.name}」采购清单（${system}，共 ${list.length} 色）：`,
          listText(sliced, system))
      }
      if (args.action === 'reconvert') {
        if (!args.name) throw new Error('reconvert 需要 name')
        const out = await reconvertFrom(args.name, args)
        return result(true,
          `已按新参数重转「${args.name}」：${out.meta.grid.cols}×${out.meta.grid.rows} 格、${out.meta.colorCount} 色 ${out.meta.totalBeads} 粒。`,
          listText(out.shoppingList.slice(0, 20), system))
      }
      throw new Error(`未知 action：${args.action}`)
    } catch (err) {
      if (err instanceof ImageSourceError) {
        // 来源问题写清楚，模型下一轮能自纠（换 attachments/换路径）
        return result(false, `图片来源问题：${err.message}`)
      }
      if (err instanceof JimengError) {
        // AI 问题（未配 key / 风险拦截 / 超时）：结构化返回，模型能引导用户处理
        return result(false, `AI 风格化失败：${err.message}`)
      }
      throw err
    }
  },
}

// reconvert 从 source.png 重跑（flows.reconvertFlow），这里桥接参数
async function reconvertFrom(name, args) {
  return reconvertFlow(name, {
    granularity: args.granularity,
    mode: args.mode,
    mergeThreshold: args.mergeThreshold,
    system: args.system,
  })
}

function shoppingListFrom(out) {
  const counts = out.pixelData ? computeStats(out.pixelData).colorCounts : {}
  return makeShoppingList(counts, out.meta.system || 'MARD')
}

function listText(list, system) {
  if (!list.length) return '（无颜色条目）'
  return list.map((item) => `${item.code} ${item.hex} × ${item.count}`).join('\n')
}

// ---------------------------------------------------------------------------
// 工具 2：perler_palette
// ---------------------------------------------------------------------------
export const perlerPaletteTool = {
  name: 'perler_palette',
  description:
    '拼豆色号对照与查色：给 hex 颜色查 MARD/COCO/漫漫/盼盼/咪小窝 五套色号（lookup）；找最接近的色板色（near）；看色板规模（systems）。291 色。' +
    '用户问「这个颜色是什么色号」「最接近的拼豆色」「色板有多少色」时使用。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('lookup 按 hex 查色号；near 找最近色板色；systems 色板规模', { enum: ['lookup', 'near', 'systems'] }),
      hex: str('lookup/near：颜色，如 #FBED56 或 FBED56'),
      rgb: str('near 可选：逗号分隔 RGB，如 "251,237,86"（与 hex 二选一）'),
      limit: num('near：返回几个最近色，默认 5'),
    },
  },
  timeoutMs: 10_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    if (args.action === 'lookup') {
      if (!args.hex) throw new Error('lookup 需要 hex（如 #FBED56）')
      const entry = lookupHex(args.hex)
      if (!entry) {
        return result(false, `${args.hex} 不在 291 色标准色板里。可用 action=near 找最接近的色板色。`)
      }
      return result(true, `#${entry.hex.replace('#', '')} 的色号对照：`,
        COLOR_SYSTEMS.map((sys) => `${sys}: ${entry[sys] ?? '?'}`).join(' | '))
    }
    if (args.action === 'near') {
      let rgb
      if (args.rgb) {
        const parts = String(args.rgb).split(/[,\s]+/).map(Number)
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) throw new Error('rgb 形如 "251,237,86"')
        rgb = { r: parts[0], g: parts[1], b: parts[2] }
      } else if (args.hex) {
        rgb = hexToRgb(args.hex)
        if (!rgb) throw new Error(`hex 不合法：${args.hex}`)
      } else {
        throw new Error('near 需要 hex 或 rgb 二选一')
      }
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5))
      const near = nearestPaletteColors(rgb, limit)
      return result(true, `最接近 ${rgbToHex(rgb)} 的 ${near.length} 个色板色：`,
        near.map((p) => {
          const entry = lookupHex(p.hex) || {}
          return `${p.hex}（距离 ${p.distance.toFixed(1)}）→ ` + COLOR_SYSTEMS.map((s) => `${s} ${entry[s] ?? '?'}`).join(' | ')
        }).join('\n'))
    }
    if (args.action === 'systems') {
      const info = paletteInfo()
      return result(true, `色板共 ${info.colors} 色，色号系统：${info.systems.join(' / ')}。`)
    }
    throw new Error(`未知 action：${args.action}`)
  },
}

export function apply(ctx, config) {
  configRef.config = config
  ctx.tools.register(perlerStudioTool)
  ctx.tools.register(perlerPaletteTool)
  ctx.effect(() => registerApi(ctx, config), `${name}: routes`)
}
