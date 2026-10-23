import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPOSER_EXTRA_HEIGHT, composerBounds, PET_SIZE, SKINS, startupError } from '../src/rules.mjs'

const OPEN_HEIGHT = PET_SIZE.height + COMPOSER_EXTRA_HEIGHT
const workArea = { x: 0, y: 25, width: 1440, height: 875 }
const closed = (y) => ({ x: 1176, y, width: PET_SIZE.width, height: PET_SIZE.height })

describe('startupError', () => {
  test('受管模式和截图模式都允许启动', () => {
    assert.equal(startupError({ managed: true, shotOnly: false, skin: 'avatar' }), undefined)
    assert.equal(startupError({ managed: false, shotOnly: true, skin: 'whale' }), undefined)
  })

  test('直接运行时拒绝启动并说明正确方式', () => {
    const message = startupError({ managed: false, shotOnly: false, skin: 'avatar' })
    assert.match(message, /只能由 DSH 拉起/)
    assert.match(message, /npm start/)
  })

  test('直接运行的报错优先于皮肤报错', () => {
    assert.match(startupError({ managed: false, shotOnly: false, skin: 'foo' }), /只能由 DSH 拉起/)
  })

  test('不支持的皮肤列出可选值，大小写敏感，空串也算错', () => {
    for (const skin of ['foo', 'Avatar', '', 'avatar ']) {
      const message = startupError({ managed: true, shotOnly: false, skin })
      assert.ok(message?.includes('avatar / whale'), `skin=${JSON.stringify(skin)} 应该报错`)
    }
  })

  test('皮肤列表不可被改写', () => {
    assert.throws(() => SKINS.push('cat'), TypeError)
    assert.deepEqual([...SKINS], ['avatar', 'whale'])
  })
})

describe('composerBounds', () => {
  test('展开时向上长高，底边、横向位置和宽度不变', () => {
    const before = closed(456)
    const result = composerBounds(before, workArea, true)
    assert.equal(result.bounds.height, OPEN_HEIGHT)
    assert.equal(result.bounds.y + result.bounds.height, before.y + before.height)
    assert.equal(result.bounds.x, before.x)
    assert.equal(result.bounds.width, before.width)
    assert.equal(result.shift, 0)
  })

  test('收起时回到原来的位置和高度', () => {
    const before = closed(456)
    const opened = composerBounds(before, workArea, true)
    const back = composerBounds(opened.bounds, workArea, false, opened.shift)
    assert.deepEqual(back.bounds, before)
    assert.equal(back.shift, 0)
  })

  test('已经是目标高度时返回 null（重复展开、重复收起）', () => {
    const opened = composerBounds(closed(456), workArea, true)
    assert.equal(composerBounds(opened.bounds, workArea, true), null)
    assert.equal(composerBounds(closed(456), workArea, false), null)
  })

  test('贴近屏幕顶部：顶边夹在工作区上沿，收起后回到原位而不是往下掉', () => {
    const before = closed(workArea.y + 30)
    const opened = composerBounds(before, workArea, true)
    assert.equal(opened.bounds.y, workArea.y)
    assert.equal(opened.shift, COMPOSER_EXTRA_HEIGHT - 30)
    const back = composerBounds(opened.bounds, workArea, false, opened.shift)
    assert.deepEqual(back.bounds, before)
  })

  test('窗口顶边恰好在工作区上沿时整段都被下推', () => {
    const before = closed(workArea.y)
    const opened = composerBounds(before, workArea, true)
    assert.equal(opened.bounds.y, workArea.y)
    assert.equal(opened.shift, COMPOSER_EXTRA_HEIGHT)
    assert.deepEqual(composerBounds(opened.bounds, workArea, false, opened.shift).bounds, before)
  })

  test('副屏在主屏上方（工作区 y 为负）也按该屏的上沿夹', () => {
    const upper = { x: 0, y: -900, width: 1440, height: 875 }
    const before = { x: 100, y: -880, width: PET_SIZE.width, height: PET_SIZE.height }
    const opened = composerBounds(before, upper, true)
    assert.equal(opened.bounds.y, -900)
    assert.deepEqual(composerBounds(opened.bounds, upper, false, opened.shift).bounds, before)
  })

  test('展开期间被拖动后收起，按拖动后的位置还原', () => {
    const opened = composerBounds(closed(workArea.y), workArea, true)
    const dragged = { ...opened.bounds, x: 300, y: opened.bounds.y + 200 }
    const back = composerBounds(dragged, workArea, false, opened.shift)
    assert.equal(back.bounds.x, 300)
    assert.equal(back.bounds.height, PET_SIZE.height)
    assert.equal(back.bounds.y, dragged.y + dragged.height - opened.shift - PET_SIZE.height)
  })

  test('收起时不传 shift 等同于底边不动', () => {
    const opened = composerBounds(closed(456), workArea, true)
    const back = composerBounds(opened.bounds, workArea, false)
    assert.equal(back.bounds.y + back.bounds.height, opened.bounds.y + opened.bounds.height)
  })
})
