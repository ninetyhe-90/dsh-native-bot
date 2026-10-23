/**
 * 真实 Electron 集成测试：真的桌宠进程 + 真的插件代码，只把 DSH 的会话服务换成替身。
 *
 * 验证「关掉桌宠 -> /pet -> 重新出现」整条链：
 *   1. 插件拉起桌宠，握手、打开会话
 *   2. 桌宠（自检模式）发一句话，替身模型回「收到」，桌宠截图后 app.quit() 退出
 *      —— 与用户点关闭按钮走同一个 app.quit()
 *   3. 执行 /pet：拉起新进程，连上后才回复成功
 *   4. 桌宠开着时再执行 /pet：不新开进程，发 show 叫到前面
 *   5. 新桌宠同样能对话、能关闭；再 /pet 第三次
 *   6. 卸载插件：当前桌宠被结束，命令注销，不留进程
 *
 * 需要图形界面（会在桌面右下角短暂出现桌宠）。运行：npm run test:e2e
 */
import { spawn } from 'node:child_process'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../plugin/desk-pet.mjs'

const STEP_TIMEOUT_MS = 30_000
const started = Date.now()
const logs = []
const originalWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, ...rest) => {
  logs.push(String(chunk))
  return originalWrite(chunk, ...rest)
}
const say = (text) => originalWrite(`[e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}\n`)

async function until(check, what, ms = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待超时：${what}`)
}
const count = (text) => logs.join('').split(text).length - 1

/** 与 dsh-subprocess 同形的最小实现：done 正常退出 resolve、拉起失败 reject；terminate 先关 stdin 再发信号。 */
const children = []
function realSpawn({ argv, cwd, env, graceMs }) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  children.push(child)
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  let terminating = false
  return {
    pid: child.pid,
    child,
    stdin: child.stdin,
    stdout: child.stdout,
    done,
    terminate() {
      if (terminating || child.exitCode !== null || child.signalCode !== null) return
      terminating = true
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
      child.once('exit', () => clearTimeout(timer))
    },
  }
}

const cwd = await realpath(await mkdtemp(join(tmpdir(), 'desk-pet-e2e-')))
const listeners = new Map()
const disposers = []
const commands = new Map()
const live = new Map()
const spawned = []
const prompts = []
const emit = (name, ...args) => listeners.get(name)?.(...args)

function reply(sessionId, text) {
  const session = { id: sessionId }
  const agent = { session }
  emit('agent/status', { agent, status: 'running' })
  emit('session/event', session, { type: 'turn/start' })
  emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })
  emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  emit('agent/status', { agent, status: 'idle' })
}

const ctx = {
  subprocess: {
    spawn(options) {
      const handle = realSpawn(options)
      spawned.push(handle)
      say(`spawn 桌宠 pid=${handle.pid}`)
      return handle
    },
  },
  on(name, listener) {
    listeners.set(name, listener)
    return () => listeners.delete(name)
  },
  effect(factory) {
    disposers.push(factory())
  },
  commands: {
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  agents: {
    get: (id) => live.get(id),
    async resume() {
      throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' })
    },
    async create({ sessionId, meta }) {
      const agent = {
        session: { id: sessionId, header: { cwd: meta.cwd } },
        followup(message) {
          prompts.push(message.content[0].text)
          setTimeout(() => reply(sessionId, '收到'), 200)
        },
      }
      live.set(sessionId, agent)
      return { agent, dispose: async () => live.delete(sessionId) }
    },
  },
  workspaceRegistry: {
    list: () => [],
    async create(path) {
      return { path, attachSession: async () => {} }
    },
  },
  sessionTitle: { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) },
}

const runPet = () => commands.get('pet').handler({ rawInput: '', attachments: [], signal: new AbortController().signal })
const exited = (handle) => handle.child.exitCode !== null || handle.child.signalCode !== null

let failed
try {
  process.env.DSH_PET_SELFTEST = '1'
  await apply(ctx, { cwd })
  assert.ok(commands.has('pet'), '/pet 已注册')

  say('1. 启动：等桌宠连上、对话、自己关闭')
  await until(() => count('桌宠已连接') === 1, '第一次握手')
  await until(() => prompts.length === 1, '第一只桌宠发出消息')
  await until(() => exited(spawned[0]), '第一只桌宠关闭')
  assert.equal(spawned[0].child.exitCode, 0, '关闭走 app.quit，退出码 0')
  await until(() => count('桌宠已关闭，在 Web UI 输入 /pet 可以重新打开') === 1, '关闭提示')
  say(`   第一只已关闭 exit=${spawned[0].child.exitCode}`)

  say('2. /pet：重新拉起')
  const reopened = await runPet()
  assert.deepEqual(reopened, { kind: 'success', text: '桌宠已重新打开' })
  assert.equal(spawned.length, 2)
  assert.notEqual(spawned[1].pid, spawned[0].pid)
  assert.equal(count('桌宠已连接'), 2, '回复成功时新桌宠已经握手')
  say(`   新桌宠 pid=${spawned[1].pid} 已连上`)

  say('3. 桌宠开着时 /pet：只叫到前面')
  const shown = await runPet()
  assert.equal(shown.kind, 'success')
  assert.match(shown.text, /已经在桌面上/)
  assert.equal(spawned.length, 2, '没有多开进程')
  assert.equal(exited(spawned[1]), false, 'show 不会让桌宠崩溃')

  say('4. 新桌宠照常对话，然后关闭')
  await until(() => prompts.length === 2, '第二只桌宠发出消息')
  await until(() => exited(spawned[1]), '第二只桌宠关闭')
  assert.equal(spawned[1].child.exitCode, 0)
  assert.equal(live.size, 1, '一直是同一个会话')

  say('5. 连续执行 /pet 三次：只拉起一个')
  const results = await Promise.all([runPet(), runPet(), runPet()])
  assert.deepEqual(results.map((result) => result.text), Array(3).fill('桌宠已重新打开'))
  assert.equal(spawned.length, 3)

  say('6. 卸载插件：结束当前桌宠，注销命令')
  for (const dispose of disposers) await dispose()
  await until(() => exited(spawned[2]), '第三只桌宠被结束', 10_000)
  assert.equal(commands.size, 0)
  assert.equal(listeners.size, 0)
  assert.ok(spawned.every(exited), '没有残留进程')
  assert.equal(count('[desk-pet] 主进程未捕获异常'), 0)
  assert.equal(count('未处理的 Promise 拒绝'), 0)
  say(`通过：共拉起 ${spawned.length} 次，${prompts.length} 轮对话，全部进程已退出`)
} catch (error) {
  failed = error
  say(`失败：${error.stack ?? error}`)
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}
process.exit(failed === undefined ? 0 : 1)
