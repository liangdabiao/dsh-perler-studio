// 图片解码：PNG（pngjs）与 JPEG（jpeg-js），纯 JS 零原生依赖，统一输出 RGBA 像素数组。
// 形状对齐原项目的 ImageData：{ width, height, data: Uint8Array(4*w*h) }。
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

/** 魔数嗅探图片类型 */
export function sniffImage(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  if (buffer.length > 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buffer.length > 6 && (buffer.toString('ascii', 0, 4) === 'GIF8')) return 'gif'
  return 'unknown'
}

/** 任意 buffer → { width, height, data(RGBA) }；webp/gif 报明确错误（一期不支持） */
export function decodeImage(buffer) {
  const type = sniffImage(buffer)
  if (type === 'png') {
    const png = PNG.sync.read(buffer)
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
  }
  if (type === 'jpeg') {
    const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true })
    return { width: img.width, height: img.height, data: new Uint8Array(img.data) }
  }
  throw new Error(`暂不支持该图片格式（识别为 ${type}）。请用 PNG 或 JPG；webp/gif 可先转成 PNG 再转换。`)
}

/** PNG buffer 编码（selftest / 测试用） */
export function encodePng({ width, height, data }) {
  const png = new PNG({ width, height })
  png.data = Buffer.from(data.buffer, data.byteOffset, data.length)
  return PNG.sync.write(png)
}
