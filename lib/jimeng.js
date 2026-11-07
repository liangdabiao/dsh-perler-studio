// 火山引擎「即梦 4.0」图生图（jimeng_t2i_v40）Host 端封装。
// 移植自 perler-beads-ai 的 functions/api/ai-optimize.ts（Apache-2.0，用户自有代码）：
// V4 签名（HMAC-SHA256，node:crypto）→ CVSync2AsyncSubmitTask → 轮询 CVSync2AsyncGetResult（60×3s 上限）。
// 风格化默认提示词与原项目一致（chibi/pixel-art）。
// 密钥走插件 Config（volcAccessKeyId / volcSecretAccessKey），绝不硬编码、绝不回显。
import { createHash, createHmac } from 'node:crypto'

const VOLC_API_HOST = 'visual.volcengineapi.com'
const VOLC_API_REGION = 'cn-north-1'
const VOLC_API_SERVICE = 'cv'
const REQ_KEY = 'jimeng_t2i_v40'

export const DEFAULT_PROMPT =
  '图片修改为：chibi画风，背景白底。pixel art style, 16-bit, retro game aesthetic, sharp focus, high contrast, clean lines, detailed pixel art, masterpiece, best quality'

export class JimengError extends Error {}
export class ImageRiskError extends JimengError {
  constructor() {
    super('IMAGE_RISK: 图片未能通过安全检测，请尝试其他图片或提示词。')
  }
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const hmacBuf = (keyBuf, text) => createHmac('sha256', keyBuf).update(text, 'utf8').digest()

// 需要忽略的 headers（与源实现一致）
const HEADER_KEYS_TO_IGNORE = new Set(['authorization', 'content-length', 'content-type', 'user-agent'])

function uriEscape(str) {
  return encodeURIComponent(str)
    .replace(/[^A-Za-z0-9_.~\-%]+/g, (c) => c)
    .replace(/[*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

function queryParamsToString(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${uriEscape(key)}=${uriEscape(params[key])}`)
    .join('&')
}

function getSignHeaders(originHeaders) {
  const keys = Object.keys(originHeaders).filter((k) => !HEADER_KEYS_TO_IGNORE.has(k.toLowerCase()))
  const signedHeaderKeys = keys.map((k) => k.toLowerCase()).sort().join(';')
  const canonicalHeaders = keys
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map((k) => `${k.toLowerCase()}:${String(originHeaders[k]).trim().replace(/\s+/g, ' ')}`)
    .join('\n')
  return [signedHeaderKeys, canonicalHeaders]
}

/** 火山引擎 V4 签名（与源实现逐步对应） */
export async function generateSignature({ method, pathName, query, headers, bodySha, accessKeyId, secretAccessKey }) {
  const datetime = headers['X-Date']
  const date = datetime.substring(0, 8)
  const [signedHeaders, canonicalHeaders] = getSignHeaders(headers)
  const canonicalRequest = [
    method.toUpperCase(),
    pathName,
    queryParamsToString(query) || '',
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodySha || sha256Hex(''),
  ].join('\n')

  const credentialScope = [date, VOLC_API_REGION, VOLC_API_SERVICE, 'request'].join('/')
  const canonicalRequestHash = sha256Hex(canonicalRequest)
  const stringToSign = ['HMAC-SHA256', datetime, credentialScope, canonicalRequestHash].join('\n')

  const kDate = hmacBuf(Buffer.from(secretAccessKey, 'utf8'), date)
  const kRegion = hmacBuf(kDate, VOLC_API_REGION)
  const kService = hmacBuf(kRegion, VOLC_API_SERVICE)
  const kSigning = hmacBuf(kService, 'request')
  const signature = kSigning.toString('hex')

  return [
    'HMAC-SHA256',
    `Credential=${accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(' ')
}

function getDateTimeNow() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function assertNoRisk(payload) {
  const code = payload?.status ?? payload?.code
  const message = payload?.message || ''
  if (code === 50411 || String(message).includes('Risk')) throw new ImageRiskError()
}

async function signedRequest({ action, body, config, fetchImpl }) {
  const { volcAccessKeyId, volcSecretAccessKey } = config
  if (!volcAccessKeyId || !volcSecretAccessKey) {
    throw new JimengError('还没有配置火山引擎 AK/SK：打开 插件 → dsh-perler-studio → Configuration 填入 AccessKeyId / SecretAccessKey。')
  }
  const bodySha = sha256Hex(body)
  const query = { Action: action, Version: '2022-08-31' }
  const headers = { host: VOLC_API_HOST, 'X-Date': getDateTimeNow(), 'content-type': 'application/json' }
  const authorization = await generateSignature({ method: 'POST', pathName: '/', query, headers, bodySha, accessKeyId: volcAccessKeyId, secretAccessKey: volcSecretAccessKey })
  const doFetch = fetchImpl || fetch
  return doFetch(`https://${VOLC_API_HOST}/?${queryParamsToString(query)}`, {
    method: 'POST',
    headers: { ...headers, Authorization: authorization },
    body,
    signal: AbortSignal.timeout(60_000),
  })
}

/** 提交图生图任务，返回 { taskId } */
export async function submitTask({ imageBase64, prompt, config, fetchImpl }) {
  const base64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64
  const body = JSON.stringify({ req_key: REQ_KEY, binary_data_base64: [base64], prompt, scale: 0.5, force_single: true })
  const res = await signedRequest({ action: 'CVSync2AsyncSubmitTask', body, config, fetchImpl })
  const responseText = await res.text()
  let data
  try { data = JSON.parse(responseText) } catch { throw new JimengError(`提交失败：HTTP ${res.status} ${responseText.slice(0, 200)}`) }
  if (!res.ok) {
    assertNoRisk(data)
    throw new JimengError(`提交失败：HTTP ${res.status} ${responseText.slice(0, 200)}`)
  }
  assertNoRisk(data)
  if (data.status && data.status !== 10000) {
    assertNoRisk(data)
    throw new JimengError(`提交被拒：status=${data.status} ${data.message || ''}`)
  }
  const taskId = data?.data?.task_id
  if (!taskId) throw new JimengError('提交成功但未返回 task_id')
  return { taskId }
}

/** 查询任务结果（原始 payload） */
export async function queryTask({ taskId, config, fetchImpl }) {
  const body = JSON.stringify({ req_key: REQ_KEY, task_id: taskId })
  const res = await signedRequest({ action: 'CVSync2AsyncGetResult', body, config, fetchImpl })
  const responseText = await res.text()
  let data
  try { data = JSON.parse(responseText) } catch { throw new JimengError(`查询失败：HTTP ${res.status} ${responseText.slice(0, 200)}`) }
  if (!res.ok) {
    assertNoRisk(data)
    throw new JimengError(`查询失败：HTTP ${res.status} ${responseText.slice(0, 200)}`)
  }
  assertNoRisk(data)
  return data
}

/**
 * 轮询到终态，返回图片（URL 或 dataURI）。
 * @param poll {maxAttempts=60, intervalMs=3000, onAttempt?, signal?}
 */
export async function waitForTaskCompletion({ taskId, config, poll = {}, fetchImpl }) {
  const { maxAttempts = 60, intervalMs = 3000, onAttempt, signal } = poll
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new JimengError('已取消')
    onAttempt?.(attempt + 1, maxAttempts)
    const result = await queryTask({ taskId, config, fetchImpl })
    const inner = result?.data
    if (inner?.status === 'done') {
      if (inner.image_urls?.length) return inner.image_urls[0]
      if (inner.binary_data_base64?.length) return `data:image/jpeg;base64,${inner.binary_data_base64[0]}`
      throw new JimengError('任务完成但未返回图片数据')
    }
    if (inner?.status === 'failed') {
      assertNoRisk({ status: result.status ?? result.code, message: result.message })
      throw new JimengError(`任务失败：${result.message || '未知错误'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new JimengError(`任务超时：轮询 ${maxAttempts} 次仍未完成（任务可能还在跑，稍后可用同参数重试）`)
}
