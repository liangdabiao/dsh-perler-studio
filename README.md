# dsh-perler-studio · 拼豆工坊

DeepSeek Harness（dsh）插件：把任意图片转成**拼豆底稿**——291 色标准色板匹配、五套色号对照（MARD / COCO / 漫漫 / 盼盼 / 咪小窝）、图纸与采购清单导出。基于 [perler-beads-ai](https://github.com/liangdabiao/perler-beads-ai)（Apache-2.0）的核心算法移植。

> 一期（本版）：转换工具集 + 侧栏面板。二期（预留）：火山即梦 4.0 AI 风格化、专心拼豆模式。

## 装上以后有什么

| 能力 | 说明 |
|---|---|
| `perler_studio` 工具 | convert 转换 / read / list / shopping 采购清单 / reconvert 改参数重转。image 支持绝对路径、http(s) 链接、dataURI、`"attachments"`（用户刚上传的聊天图片） |
| `perler_palette` 工具 | hex → 五套色号对照（lookup）、最近色板色（near）、色板规模（systems）。291 色 |
| 侧栏「拼豆工坊」面板 | 上传图片直接转换（无需模型）；项目列表；SVG 图纸预览；五套色号统计与采购清单；**下载图纸 PNG**（canvas 绘制：网格线+每格色号+统计区）、SVG、CSV |
| 数据 | 全部在 `$DSH_HOME/perler-studio/<项目>/`：`project.json`、`pattern.json`、`beads.svg`、`beads.csv`、`source.png` |

工具和面板走**同一份转换逻辑**（`lib/flows.js`），模型在对话里转的图、面板里转的图，落的是同一个项目库。

## 使用

对话里直接说：

- 「把这张图转成拼豆图纸，40 格」（用户刚上传的图 → 工具自动用 `attachments` 通道）
- 「这个颜色 #FBED56 是什么色号？」
- 「颗粒太少了，改 80 格重新转一下」（reconvert）

或打开侧栏「拼豆工坊」：选图片 → 生成 → 看图纸/采购清单 → 下载 PNG。

参数说明：`granularity` 横向格子数（5~200，默认 50，越大越细腻）；`mergeThreshold` 近似色合并阈值（0~255，默认 30，越大颜色越少）；`mode` dominant 卡通风（主色池化）/ average 真实风（均值）；`removeBg` 自动去背景（边界洪水填充，带纯色图保护：全图同色时跳过，不会清空）。

## 自检

```bash
npm install && npm test && npm run selftest && npm run build
```

- `npm test`：16 个单测（色板/量化/合并/去背景/CSV 往返/SVG/路径安全/鉴权），零 dsh 依赖
- `npm run selftest`：程序化生成测试图 → 转换全链路 → 校验产物，不花任何积分
- `npm run build`：打包 `dist/client.js` 并做产物三自检（require 白名单/无动态 import/单文件）

## 开发调试

```bash
scripts/dev-sandbox.ps1 4313   # 隔离 DSH_HOME 起网页版（Windows）；bash 用 dev-sandbox.sh
```

## 安全

- 图片来源四通道都有限制：URL 只接受公网 http(s)（拒绝内网/本机地址，防 SSRF，每跳重定向复查）；本地路径只接受绝对路径；大小上限 20MB；格式限 PNG/JPG。
- 面板每个请求都过宿主鉴权（`connection.requestRejection`）+ 同源校验；静态产物只伺服 `$DSH_HOME/perler-studio/` 内的文件。
- 插件不携带任何密钥。⚠️ **提醒**：上游仓库 perler-beads-ai 的 `env` 文件曾明文提交过火山引擎 AK/SK（已随仓库公开）——如果你用过那对密钥，请尽快到[火山引擎控制台](https://console.volcengine.com)轮换/禁用。本插件的 AI 风格化（二期）会把 AK/SK 做成用户配置，不硬编码。

## 许可

Apache-2.0。核心算法与色板数据移植自 [perler-beads-ai](https://github.com/liangdabiao/perler-beads-ai)（基于 [Zippland/perler-beads](https://github.com/Zippland/perler-beads) 上游），保留其 Apache-2.0 声明。

特别致谢社区支持：https://linux.do
