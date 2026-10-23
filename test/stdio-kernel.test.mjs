import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { StdioKernel } from '../src/stdio-kernel.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 一个用内存流代替 stdin/stdout 的内核，parent 模拟 DSH 插件那一端。 */
function setup(handshakeTimeoutMs = 200) {
  const input = new PassThrough()
  const output = new PassThrough()
  const sent = []
  let pending = ''
  output.setEncoding('utf8')
  output.on('data', (chunk) => {
    pending += chunk
    let index
    while ((index = pending.indexOf('\n')) !== -1) {
      sent.push(JSON.parse(pending.slice(0, index)))
      pending = pending.slice(index + 1)
    }
  })
  const kernel = new StdioKernel({ input, output, handshakeTimeoutMs })
  const parent = {
    write: (text) => input.write(text),
    send: (frame) => input.write(`${JSON.stringify(frame)}\n`),
    close: () => input.end(),
  }
  return { kernel, parent, sent, input }
}

async function connected() {
  const ctx = setup()
  const starting = ctx.kernel.start()
  ctx.parent.send({ type: 'ready', sessionId: 'desk-pet' })
  await starting
  return ctx
}

let stderr
beforeEach(() => {
  stderr = []
  mock.method(process.stderr, 'write', (chunk) => {
    stderr.push(String(chunk))
    return true
  })
})
afterEach(() => mock.restoreAll())

describe('StdioKernel 握手', () => {
  test('启动时发出 ready（带 pid），父进程回 ready 后才 alive', async () => {
    const { kernel, parent, sent } = setup()
    const starting = kernel.start()
    await tick()
    assert.deepEqual(sent, [{ type: 'ready', pid: process.pid }])
    assert.equal(kernel.alive, false)
    parent.send({ type: 'ready', sessionId: 'desk-pet' })
    await starting
    assert.equal(kernel.alive, true)
  })

  test('重复 start 只握手一次', async () => {
    const { kernel, sent } = await connected()
    await kernel.start()
    await tick()
    assert.equal(sent.filter((frame) => frame.type === 'ready').length, 1)
  })

  test('超时未回应：start 抛错，之后迟到的 ready 不算数，prompt 被拒', async () => {
    const { kernel, parent, sent } = setup(30)
    await assert.rejects(kernel.start(), /等待 DSH 插件回应超时（30ms）/)
    assert.equal(kernel.alive, false)
    parent.send({ type: 'ready' })
    await tick()
    assert.equal(kernel.alive, false)
    await assert.rejects(kernel.prompt('hi'), /尚未与 DSH 插件握手/)
    assert.equal(sent.filter((frame) => frame.type === 'prompt').length, 0)
  })

  test('超时之后父进程退出，仍然发 exit，桌宠能跟着退', async () => {
    const { kernel, parent } = setup(30)
    await assert.rejects(kernel.start())
    const exits = []
    kernel.on('exit', (info) => exits.push(info))
    parent.close()
    await tick()
    assert.equal(exits.length, 1)
  })

  test('握手前父进程关闭：start 抛「父进程已关闭」，exit 只发一次', async () => {
    const { kernel, parent, input } = setup(1_000)
    const exits = []
    kernel.on('exit', (info) => exits.push(info))
    const starting = kernel.start()
    parent.close()
    await assert.rejects(starting, /父进程已关闭/)
    input.emit('error', new Error('EPIPE'))
    await tick()
    assert.equal(exits.length, 1)
    assert.equal(exits[0].stderr, '父进程已关闭')
  })

  test('握手前管道出错：start 抛错并带上原因', async () => {
    const { kernel, input } = setup(1_000)
    const starting = kernel.start()
    input.emit('error', new Error('read ECONNRESET'))
    await assert.rejects(starting, /父进程管道断开：read ECONNRESET/)
  })
})

describe('StdioKernel 收发', () => {
  test('prompt 原样转成一行 JSON，包括换行和特殊字符', async () => {
    const { kernel, sent } = await connected()
    const text = '第一行\n第二行 "引号" \\ \u{10437}'
    await kernel.prompt(text)
    await tick()
    assert.deepEqual(sent.at(-1), { type: 'prompt', text })
  })

  test('转发 session-event 和 status，过滤缺字段或类型不对的帧', async () => {
    const { kernel, parent } = await connected()
    const events = []
    const statuses = []
    kernel.on('session-event', (payload) => events.push(payload))
    kernel.on('session-status', (payload) => statuses.push(payload))
    parent.send({ type: 'session-event', event: { type: 'turn/start' } })
    parent.send({ type: 'session-event' })
    parent.send({ type: 'status', status: 'running' })
    parent.send({ type: 'status', status: 1 })
    await tick()
    assert.deepEqual(events, [{ event: { type: 'turn/start' } }])
    assert.deepEqual(statuses, [{ status: 'running' }])
  })

  test('error 帧带 label 时透传，message 不是字符串时用兜底文案', async () => {
    const { kernel, parent } = await connected()
    const errors = []
    kernel.on('prompt-error', (error) => errors.push(error))
    parent.send({ type: 'error', label: '没能放进侧边栏', message: 'ENOENT' })
    parent.send({ type: 'error', message: 42 })
    parent.send({ type: 'error' })
    await tick()
    assert.equal(errors.length, 3)
    assert.deepEqual([errors[0].label, errors[0].message], ['没能放进侧边栏', 'ENOENT'])
    assert.deepEqual([errors[1].label, errors[1].message], [undefined, '桌宠桥报错'])
    assert.equal(errors[2].message, '桌宠桥报错')
  })

  test('show 帧触发 show 事件（DSH 里执行了 /pet 而桌宠开着）', async () => {
    const { kernel, parent } = await connected()
    let shown = 0
    kernel.on('show', () => {
      shown += 1
    })
    parent.send({ type: 'show' })
    parent.send({ type: 'show', extra: 1 })
    await tick()
    assert.equal(shown, 2)
  })

  test('坏帧、空行、CRLF、拆包和粘包都不影响后续帧', async () => {
    const { kernel, parent } = await connected()
    const statuses = []
    kernel.on('session-status', (payload) => statuses.push(payload.status))
    parent.write('not json\n')
    parent.write('null\n42\n"text"\n[]\n{"type":"unknown"}\n\n   \n')
    parent.write('{"type":"status","status":"running"}\r\n')
    parent.write('{"type":"sta')
    await tick()
    parent.write('tus","status":"idle"}\n{"type":"status","status":"running"}\n')
    await tick()
    assert.deepEqual(statuses, ['running', 'idle', 'running'])
    assert.ok(stderr.some((line) => line.includes('丢弃无法解析的帧')))
  })

  test('多字节字符被拆在两个 chunk 之间也能正确解码', async () => {
    const { kernel, input } = await connected()
    const errors = []
    kernel.on('prompt-error', (error) => errors.push(error.message))
    const bytes = Buffer.from(`${JSON.stringify({ type: 'error', message: '中文' })}\n`)
    const cut = bytes.indexOf(Buffer.from('中')) + 1
    input.write(bytes.subarray(0, cut))
    await tick()
    input.write(bytes.subarray(cut))
    await tick()
    assert.deepEqual(errors, ['中文'])
  })

  test('父进程退出后 alive 变 false，prompt 被拒，exit 只发一次', async () => {
    const { kernel, parent, input } = await connected()
    const exits = []
    kernel.on('exit', (info) => exits.push(info))
    parent.close()
    await tick()
    input.emit('error', new Error('late'))
    assert.equal(kernel.alive, false)
    await assert.rejects(kernel.prompt('hi'), /父进程已断开/)
    assert.equal(exits.length, 1)
  })

  test('主动 close 之后不再发 exit，也不再接受 prompt', async () => {
    const { kernel, parent } = await connected()
    const exits = []
    kernel.on('exit', (info) => exits.push(info))
    await kernel.close()
    assert.equal(kernel.alive, false)
    parent.close()
    await tick()
    assert.equal(exits.length, 0)
    await assert.rejects(kernel.prompt('hi'), /父进程已断开/)
  })
})
