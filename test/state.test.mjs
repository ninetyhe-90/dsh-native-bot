import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assistantText, describeTool, initialState, reduceEvent, reduceStatus, STATES } from '../src/state.mjs'

const state = (name, text = '') => ({ name, label: '', text, at: 0 })

describe('describeTool', () => {
  test('命令里的空白折叠成一个空格', () => {
    assert.equal(describeTool('shell', { command: 'ls   -la\n  /tmp' }), 'ls -la /tmp')
  })

  test('命令超过 48 个字符截断并加省略号', () => {
    const label = describeTool('shell', { command: 'x'.repeat(100) })
    assert.equal(label.length, 48)
    assert.ok(label.endsWith('…'))
  })

  test('恰好 48 个字符不截断', () => {
    assert.equal(describeTool('shell', { command: 'y'.repeat(48) }), 'y'.repeat(48))
  })

  test('参数是 JSON 字符串时先解析', () => {
    assert.equal(describeTool('shell', '{"command":"pwd"}'), 'pwd')
  })

  test('依次识别 path / file_path / filePath / pattern', () => {
    assert.equal(describeTool('read', { path: '/a' }), 'read /a')
    assert.equal(describeTool('read', { file_path: '/b' }), 'read /b')
    assert.equal(describeTool('read', { filePath: '/c' }), 'read /c')
    assert.equal(describeTool('grep', { pattern: 'foo' }), 'grep foo')
  })

  test('路径超过 36 个字符截断', () => {
    const label = describeTool('read', { path: 'p'.repeat(80) })
    assert.equal(label, `read ${'p'.repeat(35)}…`)
  })

  test('参数无法解析、不是对象、为 null 或字段为空时只显示工具名', () => {
    assert.equal(describeTool('t', '{bad json'), 't')
    assert.equal(describeTool('t', '42'), 't')
    assert.equal(describeTool('t', null), 't')
    assert.equal(describeTool('t', undefined), 't')
    assert.equal(describeTool('t', { command: '' }), 't')
    assert.equal(describeTool('t', { command: 123 }), 't')
    assert.equal(describeTool('t', { path: '' }), 't')
    assert.equal(describeTool('t', {}), 't')
  })
})

describe('assistantText', () => {
  test('只拼接 text 块并去掉首尾空白', () => {
    const message = {
      content: [
        { type: 'text', text: '  你好' },
        { type: 'thinking', text: '不该出现' },
        { type: 'text', text: '世界 ' },
        { type: 'text', text: 42 },
        null,
      ],
    }
    assert.equal(assistantText(message), '你好世界')
  })

  test('没有 content 或 content 不是数组时返回空串', () => {
    assert.equal(assistantText(undefined), '')
    assert.equal(assistantText(null), '')
    assert.equal(assistantText({}), '')
    assert.equal(assistantText({ content: 'text' }), '')
    assert.equal(assistantText({ content: [] }), '')
  })
})

describe('reduceEvent', () => {
  test('初始状态是 idle 且没有文字', () => {
    const initial = initialState()
    assert.equal(initial.name, STATES.IDLE)
    assert.equal(initial.text, '')
    assert.equal(typeof initial.at, 'number')
  })

  test('turn/start 和 step/start 进入思考并清空文字', () => {
    for (const type of ['turn/start', 'step/start']) {
      const next = reduceEvent(state(STATES.TALKING, '旧话'), { type })
      assert.equal(next.name, STATES.THINKING)
      assert.equal(next.text, '')
    }
  })

  test('tool/call 进入干活并带上命令', () => {
    const next = reduceEvent(state(STATES.THINKING), {
      type: 'tool/call',
      data: { name: 'shell', arguments: '{"command":"npm test"}' },
    })
    assert.equal(next.name, STATES.WORKING)
    assert.equal(next.label, 'npm test')
  })

  test('tool/call 缺少 data 时工具名回落为 tool', () => {
    const next = reduceEvent(state(STATES.THINKING), { type: 'tool/call' })
    assert.equal(next.name, STATES.WORKING)
    assert.equal(next.label, 'tool')
  })

  test('tool/result 只看 message.isError 判失败', () => {
    const failed = reduceEvent(state(STATES.WORKING), {
      type: 'tool/result',
      data: { message: { isError: true }, error: { name: 'ENOENT', reason: '文件不存在' } },
    })
    assert.deepEqual([failed.name, failed.label, failed.text], [STATES.ERROR, 'ENOENT', '文件不存在'])

    const bare = reduceEvent(state(STATES.WORKING), { type: 'tool/result', data: { message: { isError: true } } })
    assert.deepEqual([bare.name, bare.label, bare.text], [STATES.ERROR, '工具调用失败', ''])

    // 只有 data.error、没有 isError 不算失败。
    const onlyDetail = reduceEvent(state(STATES.WORKING), { type: 'tool/result', data: { error: { name: 'x' } } })
    assert.equal(onlyDetail.name, STATES.THINKING)

    // isError 必须严格为 true。
    const truthy = reduceEvent(state(STATES.WORKING), { type: 'tool/result', data: { message: { isError: 'yes' } } })
    assert.equal(truthy.name, STATES.THINKING)
  })

  test('assistant/message 有文字就说话，没文字回到思考', () => {
    const talking = reduceEvent(state(STATES.THINKING), {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '收到' }] } },
    })
    assert.deepEqual([talking.name, talking.text], [STATES.TALKING, '收到'])

    const empty = reduceEvent(state(STATES.THINKING), {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '   ' }] } },
    })
    assert.equal(empty.name, STATES.THINKING)

    const missing = reduceEvent(state(STATES.THINKING), { type: 'assistant/message' })
    assert.equal(missing.name, STATES.THINKING)
  })

  test('turn/end error 显示错误码和原因，没有错误码时不带', () => {
    const coded = reduceEvent(state(STATES.THINKING), {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '限流' } } },
    })
    assert.deepEqual([coded.name, coded.label, coded.text], [STATES.ERROR, '本轮失败 RATE_LIMIT', '限流'])

    const plain = reduceEvent(state(STATES.THINKING), { type: 'turn/end', data: { reason: { kind: 'error' } } })
    assert.deepEqual([plain.name, plain.label, plain.text], [STATES.ERROR, '本轮失败', ''])
  })

  test('turn/end blocked 报错，aborted 回待机并清空文字', () => {
    const blocked = reduceEvent(state(STATES.THINKING), { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
    assert.deepEqual([blocked.name, blocked.label], [STATES.ERROR, '本轮被拦截'])

    const aborted = reduceEvent(state(STATES.TALKING, '说到一半'), { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    assert.deepEqual([aborted.name, aborted.text], [STATES.IDLE, ''])
  })

  test('turn/end 正常结束或缺少 reason 时保留刚说完的话', () => {
    for (const data of [{ reason: { kind: 'completed' } }, { reason: { kind: 'max-tokens' } }, {}, undefined]) {
      const next = reduceEvent(state(STATES.TALKING, '最后一句'), { type: 'turn/end', data })
      assert.deepEqual([next.name, next.text], [STATES.IDLE, '最后一句'])
    }
  })

  test('不认识的事件返回 null，不影响表现', () => {
    assert.equal(reduceEvent(state(STATES.IDLE), { type: 'session/title' }), null)
    assert.equal(reduceEvent(state(STATES.IDLE), { type: '' }), null)
  })
})

describe('reduceStatus', () => {
  test('running 从待机或思考进入思考', () => {
    assert.equal(reduceStatus(state(STATES.IDLE), 'running').name, STATES.THINKING)
    assert.equal(reduceStatus(state(STATES.ERROR), 'running').name, STATES.THINKING)
  })

  test('running 不打断正在干活或说话的状态', () => {
    assert.equal(reduceStatus(state(STATES.WORKING), 'running'), null)
    assert.equal(reduceStatus(state(STATES.TALKING), 'running'), null)
  })

  test('idle 回待机并保留文字', () => {
    const next = reduceStatus(state(STATES.TALKING, '还在显示'), 'idle')
    assert.deepEqual([next.name, next.text], [STATES.IDLE, '还在显示'])
  })

  test('其它状态值返回 null', () => {
    assert.equal(reduceStatus(state(STATES.IDLE), 'paused'), null)
    assert.equal(reduceStatus(state(STATES.IDLE), undefined), null)
  })
})
