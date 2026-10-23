/**
 * 主进程和插件共用的纯规则：可选皮肤、启动前检查、输入框展开时的窗口尺寸。
 * 不依赖 Electron，方便单独测试。
 */

export const SKINS = Object.freeze(['avatar', 'whale'])
export const PET_SIZE = Object.freeze({ width: 240, height: 420 })
/** 多行输入框比原来的单行输入条多出来的高度。 */
export const COMPOSER_EXTRA_HEIGHT = 120

/**
 * 启动前检查。
 * @param {{ managed: boolean, shotOnly: boolean, skin: string }} options
 * @returns {string | undefined} 错误说明；没有问题时返回 undefined
 */
export function startupError({ managed, shotOnly, skin }) {
  if (!managed && !shotOnly) {
    return '桌宠只能由 DSH 拉起：在项目目录执行 npm start，或把 cordis.patch.yml 挂进 DSH profile 后运行 dsh web。'
  }
  if (!SKINS.includes(skin)) {
    return `DSH_PET_SKIN=${skin} 不支持，可选值：${SKINS.join(' / ')}`
  }
  return undefined
}

/**
 * 输入框展开时窗口向上长高，底边不动，角色在屏幕上的位置就不会跳。
 *
 * 窗口贴近屏幕顶部时，长高后顶边会越过工作区上沿，只能被夹住，底边随之下移；
 * 下移量记在 shift 里，收起时还回去，角色回到展开前的位置。
 *
 * @param {{ x: number, y: number, width: number, height: number }} bounds 当前窗口
 * @param {{ y: number }} workArea 窗口所在显示器的工作区
 * @param {boolean} open 是否展开
 * @param {number} shift 上次展开时底边被下推的距离，收起时传入
 * @returns {{ bounds: object, shift: number } | null} 新的窗口尺寸和本次下推量；无需变化时返回 null
 */
export function composerBounds(bounds, workArea, open, shift = 0) {
  const height = open ? PET_SIZE.height + COMPOSER_EXTRA_HEIGHT : PET_SIZE.height
  if (bounds.height === height) return null
  if (open) {
    const wanted = bounds.y + bounds.height - height
    const y = Math.max(workArea.y, wanted)
    return { bounds: { x: bounds.x, y, width: bounds.width, height }, shift: y - wanted }
  }
  const bottom = bounds.y + bounds.height - shift
  const y = Math.max(workArea.y, bottom - height)
  return { bounds: { x: bounds.x, y, width: bounds.width, height }, shift: 0 }
}
