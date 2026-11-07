// 图片来源解析：把工具参数里的 image 解析成 buffer。
// 四通道：绝对路径 / http(s) URL / dataURI / "attachments"（扫 dsh 附件存储取最新图片）。
// 安全校验：路径拒绝穿越；URL 仅 http(s) 且拒绝私网地址（SSRF 防护）；大小上限 20MB。
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep, isAbsolute } from 'node:path'
import { sniffImage } from './decode.js'

const MAX_BYTES = 20 * 1024 * 1024

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./,
]

/** 判定主机是否私网（IPv4 段 / IPv6 本地 / localhost 名） */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (host.startsWith('[')) return /^\[(::1|fc|fd|fe80)/i.test(host)
  if (PRIVATE_V4.some((re) => re.test(host))) return true
  if (/^::ffff:/i.test(host)) return isPrivateHost(host.slice(7))
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(host)) return true
  if (/^fe[89ab]/i.test(host)) return true
  return false
}

export class ImageSourceError extends Error {}

export async function resolveImageBuffer(image) {
  const value = String(image || '').trim()
  if (!value) throw new ImageSourceError('缺少图片：image 传 绝对路径 / http(s) URL / dataURI / "attachments"')

  // ① 附件通道：模型拿不到聊天附件 URL，特殊值 "attachments" 扫 dsh 附件存储取最新图片
  if (value === 'attachments') return resolveLatestAttachment()

  // ② dataURI
  const dataUri = value.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i)
  if (dataUri) {
    const buffer = Buffer.from(dataUri[2], 'base64')
    return checkSize(buffer, 'dataURI')
  }

  // ③ URL（仅公网 http(s)，手动跟随 redirect 且每跳复查）
  if (/^https?:\/\//i.test(value)) return fetchPublic(value, 0)

  // ④ 本地路径（绝对路径；拒绝穿越——读文件本身没有“目录内”约束，但拒绝明显的相对路径注入）
  if (isAbsolute(value)) {
    const buffer = await readFile(resolve(value)).catch(() => {
      throw new ImageSourceError(`读不到本地图片：${value}（模型沙箱里的相对路径要先解析成绝对路径再传）`)
    })
    return checkSize(buffer, value)
  }
  throw new ImageSourceError('image 要么是绝对路径、http(s) URL、dataURI，要么是 "attachments"')
}

async function checkSize(buffer, label) {
  if (buffer.length > MAX_BYTES) throw new ImageSourceError(`图片超过 20MB 上限（${label}）`)
  const type = sniffImage(buffer)
  if (type !== 'png' && type !== 'jpeg') {
    throw new ImageSourceError(`识别为 ${type}，只支持 PNG/JPG（可先转格式）`)
  }
  return buffer
}

async function fetchPublic(url, depth) {
  if (depth > 4) throw new ImageSourceError('重定向次数过多')
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ImageSourceError('只接受 http(s) URL')
  if (isPrivateHost(parsed.hostname)) throw new ImageSourceError('拒绝访问内网/本机地址（SSRF 防护）')
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get('location')
    if (!location) throw new ImageSourceError('重定向缺少 location')
    return fetchPublic(new URL(location, url).href, depth + 1)
  }
  if (!res.ok) throw new ImageSourceError(`下载失败：HTTP ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  return checkSize(Buffer.from(arrayBuffer), url)
}

/** 扫 $DSH_HOME/attachments/v1/objects/<2hex>/<sha256>，按 mtime 取最新的 PNG/JPEG */
async function resolveLatestAttachment() {
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'attachments', 'v1', 'objects')
  let best = null
  let bestMtime = -1
  let groups = []
  try { groups = await readdir(root) } catch {
    throw new ImageSourceError('没有找到 dsh 附件存储（用户还没有通过上传按钮传过图）。请让用户上传图片，或改用绝对路径/URL。')
  }
  for (const group of groups) {
    if (!/^[0-9a-f]{2}$/.test(group)) continue
    const dir = join(root, group)
    let files = []
    try { files = await readdir(dir) } catch { continue }
    for (const file of files) {
      const full = join(dir, file)
      const st = await stat(full).catch(() => null)
      if (!st || !st.isFile()) continue
      const head = await readFile(full).then((b) => b.subarray(0, 8)).catch(() => null)
      if (!head) continue
      const type = sniffImage(head.length >= 8 ? head : Buffer.alloc(0))
      if (type !== 'png' && type !== 'jpeg') continue
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs
        best = full
      }
    }
  }
  if (!best) throw new ImageSourceError('附件存储里没有 PNG/JPG。注意：同图去重导致 mtime 不随重传更新，多会话混用时的“最新附件”可能不是刚传的图。')
  return checkSize(await readFile(best), best)
}
