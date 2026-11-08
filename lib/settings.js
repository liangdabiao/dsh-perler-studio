// 拼豆工坊 · 面板侧密钥配置（$DSH_HOME/perler-studio/settings.json）。
// 面板「设置」标签直接配火山 AK/SK——比插件市场页的 Configuration 卡片可发现性强得多。
// 安全：文件不进 git；API 永不回显明文，只返回掩码与是否已配置。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { dataRoot } from './project.js'

const SETTINGS_FILE = () => join(dataRoot(), 'settings.json')

function load() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function save(settings) {
  const file = SETTINGS_FILE()
  mkdirSync(dataRoot(), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch { /* Windows 上忽略 */ }
}

export function getSettings() {
  const s = load()
  return {
    volcAccessKeyId: typeof s.volcAccessKeyId === 'string' ? s.volcAccessKeyId : '',
    volcSecretAccessKey: typeof s.volcSecretAccessKey === 'string' ? s.volcSecretAccessKey : '',
  }
}

// 保存（空串字段保留原值，便于只改其一）。
export function saveSettings({ volcAccessKeyId, volcSecretAccessKey }) {
  const prev = load()
  const next = {
    volcAccessKeyId: typeof volcAccessKeyId === 'string' && volcAccessKeyId.trim() ? volcAccessKeyId.trim() : prev.volcAccessKeyId || '',
    volcSecretAccessKey: typeof volcSecretAccessKey === 'string' && volcSecretAccessKey.trim() ? volcSecretAccessKey.trim() : prev.volcSecretAccessKey || '',
  }
  save(next)
  return maskSettings(next)
}

export function clearSettings() {
  save({ volcAccessKeyId: '', volcSecretAccessKey: '' })
}

// 是否已配置（面板健康检查/提示用）。
export function isConfigured() {
  const s = getSettings()
  return Boolean(s.volcAccessKeyId && s.volcSecretAccessKey)
}

// 解析生效的密钥：面板 settings.json 优先（用户刚在面板里配的），回落到插件 Config。
export function resolveCredentials(config = {}) {
  const s = getSettings()
  return {
    volcAccessKeyId: s.volcAccessKeyId || config.volcAccessKeyId || '',
    volcSecretAccessKey: s.volcSecretAccessKey || config.volcSecretAccessKey || '',
  }
}

// 掩码视图（API 返回用，绝不回明文）。
export function maskSettings(s = getSettings()) {
  const mask = (v) => (v ? `${v.slice(0, 4)}****${v.slice(-4)}` : '')
  return {
    configured: Boolean(s.volcAccessKeyId && s.volcSecretAccessKey),
    accessKeyMasked: mask(s.volcAccessKeyId),
    secretKeyMasked: s.volcSecretAccessKey ? '****' : '',
  }
}
