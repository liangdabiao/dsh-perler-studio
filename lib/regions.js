// 同色连通域（移植自 perler-beads-ai 的 floodFillUtils.ts，Apache-2.0，纯函数无依赖）。
// 专心拼豆模式的引导核心：按颜色取连通区域，支持"最近优先 / 大块优先"排序。
// 注意：可在浏览器端运行（client.js 经 esbuild 内联），不得引入 node 模块。

/** 单色连通域（4 邻域洪水填充），跳过外部/擦除格 */
export function getConnectedRegion(pixelData, startRow, startCol, targetColor) {
  if (!pixelData || !pixelData[startRow] || !pixelData[startRow][startCol]) return []
  const M = pixelData.length
  const N = pixelData[0].length
  const visited = Array.from({ length: M }, () => new Array(N).fill(false))
  const region = []
  const stack = [[startRow, startCol]]
  while (stack.length > 0) {
    const [row, col] = stack.pop()
    if (row < 0 || row >= M || col < 0 || col >= N || visited[row][col]) continue
    const cell = pixelData[row][col]
    if (!cell || cell.isExternal || cell.color !== targetColor) continue
    visited[row][col] = true
    region.push({ row, col })
    stack.push([row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1])
  }
  return region
}

/** 某颜色的全部连通域 */
export function getAllConnectedRegions(pixelData, targetColor) {
  if (!pixelData || pixelData.length === 0) return []
  const M = pixelData.length
  const N = pixelData[0].length
  const visited = Array.from({ length: M }, () => new Array(N).fill(false))
  const regions = []
  for (let row = 0; row < M; row++) {
    for (let col = 0; col < N; col++) {
      if (!visited[row][col]) {
        const cell = pixelData[row][col]
        if (cell && !cell.isExternal && cell.color === targetColor) {
          const region = getConnectedRegion(pixelData, row, col, targetColor)
          if (region.length > 0) {
            regions.push(region)
            for (const { row: r, col: c } of region) visited[r][c] = true
          }
        }
      }
    }
  }
  return regions
}

export function isRegionCompleted(region, completedCells) {
  return region.every(({ row, col }) => completedCells.has(`${row},${col}`))
}

export function isRegionPartiallyCompleted(region, completedCells) {
  return region.some(({ row, col }) => completedCells.has(`${row},${col}`))
}

export function getRegionCenter(region) {
  if (region.length === 0) return { row: 0, col: 0 }
  const totalRow = region.reduce((sum, cell) => sum + cell.row, 0)
  const totalCol = region.reduce((sum, cell) => sum + cell.col, 0)
  return { row: Math.floor(totalRow / region.length), col: Math.floor(totalCol / region.length) }
}

/** 最近优先（曼哈顿距离，相对参考点） */
export function sortRegionsByDistance(regions, referencePoint) {
  return [...regions].sort((a, b) => {
    const centerA = getRegionCenter(a)
    const centerB = getRegionCenter(b)
    const distanceA = Math.abs(centerA.row - referencePoint.row) + Math.abs(centerA.col - referencePoint.col)
    const distanceB = Math.abs(centerB.row - referencePoint.row) + Math.abs(centerB.col - referencePoint.col)
    return distanceA - distanceB
  })
}

/** 大块优先 */
export function sortRegionsBySize(regions) {
  return [...regions].sort((a, b) => b.length - a.length)
}

/**
 * 视口点击坐标 → 网格行列（与原项目 canvasUtils.clientToGridCoords 同语义）。
 * 画布常被 maxWidth 缩放显示：必须按 显示尺寸/画布尺寸 的比例还原。
 * @param rect getBoundingClientRect()（显示尺寸）
 * @param canvasWidth/canvasHeight 画布内部分辨率
 * @param cellSize 每格内部分辨率边长
 */
export function clientToGrid(rect, canvasWidth, canvasHeight, cellSize, clientX, clientY) {
  if (!rect || rect.width === 0 || rect.height === 0) return null
  const scaleX = canvasWidth / rect.width
  const scaleY = canvasHeight / rect.height
  const col = Math.floor((clientX - rect.left) * scaleX / cellSize)
  const row = Math.floor((clientY - rect.top) * scaleY / cellSize)
  return { row, col }
}
