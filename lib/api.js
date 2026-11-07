// 面板数据面：/perler-studio 前缀路由（原生 req/res）。
// 与工具共用 lib 层（官方「一次操作两个调用方」：面板按钮和模型工具走同一份转换逻辑）。
// 每请求鉴权三件套：connection.requestRejection + Origin↔Host 同源 + sec-fetch-site。
import { join, extname } from 'node:path'
import { createReadStream, statSync, existsSync } from 'node:fs'
import { convertFlow, readFlow, listFlow } from './flows.js'
import { dataRoot, safeFileUnder } from './project.js'
import { lookupHex } from './palette.js'

const BASE = '/perler-studio'
const MIME = {
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
}

/** 每请求鉴权：web 服务不替插件路由鉴权。导出是为了测试（fail closed）。 */
export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** POST JSON 防护：限 POST / JSON / 同源 / 8MB（上传图转 dataURI 场景放宽） */
export function readJson(req, max = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return reject(Object.assign(new Error('只接受 POST'), { status: 405 }))
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return reject(Object.assign(new Error('要 application/json'), { status: 415 }))
    }
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') {
      return reject(Object.assign(new Error('拒绝跨站请求'), { status: 403 }))
    }
    const origin = req.headers.origin
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
      return reject(Object.assign(new Error('Origin 与 Host 不同源'), { status: 403 }))
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > max) { req.destroy(); return reject(Object.assign(new Error('请求体过大'), { status: 413 })) }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

export function registerApi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { error: '未授权' })
        const url = new URL(req.url, 'http://x')
        const path = url.pathname.slice(BASE.length) || '/'

        if (path === '/api/health' && req.method === 'GET') {
          return json(res, 200, { ok: true, phase: 1, ai: false })
        }
        if (path === '/api/projects' && req.method === 'GET') {
          return json(res, 200, { projects: listFlow() })
        }
        if (path === '/api/project' && req.method === 'GET') {
          const name = url.searchParams.get('name') || ''
          return json(res, 200, readFlow(name))
        }
        if (path === '/api/convert' && req.method === 'POST') {
          // 面板通道：body 传 { imageDataUri | imagePath, name, granularity, mode, mergeThreshold, removeBg, system }
          const body = await readJson(req)
          const result = convertFlow(body)
          return json(res, 200, { ok: true, project: result.meta, colorCounts: result.colorCounts, totalBeads: result.totalBeads, removedBackgroundKey: result.removedBackgroundKey, mergedColors: result.mergedColors })
        }
        if (path === '/api/lookup' && req.method === 'GET') {
          const hex = url.searchParams.get('hex') || ''
          return json(res, 200, { hex, entry: lookupHex(hex) })
        }

        // 静态产物：svg/csv 只允许 $DSH_HOME/perler-studio 内、且命中登记项目
        const file = safeFileUnder(dataRoot(), path.startsWith('/') ? path.slice(1) : path)
        if (file && existsSync(file)) {
          const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
          res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'no-cache' })
          if (req.method === 'HEAD') return res.end()
          return createReadStream(file).pipe(res)
        }
        json(res, 404, { error: 'not found' })
      } catch (err) {
        const status = typeof err?.status === 'number' ? err.status : 500
        json(res, status, { error: err?.message || '内部错误' })
      }
    },
  })
}
