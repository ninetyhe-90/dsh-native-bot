import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject } from '../plugin/desk-pet.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function until(check, what, ms = 1_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await tick()
  }
  throw new Error(`等待超时：${what}`)
}

function notFound() {
  const error = new Error('session not found')
  error.name = 'SessionPersistenceNotFoundError'
  return error
}

/** 可以手动放行的闸门，用来卡住 resume，制造「打开会话途中」的时序。 */
function gate() {
  let open
  const promise = new Promise((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * 一个假的桌宠进程：stdin 收插件发来的帧，stdout 由测试写入模拟桌宠发出的帧。
 * terminate 和真实进程一样会让 done 以信号结束。
 */
function fakeProcess() {
  const toPet = new PassThrough()
  const fromPet = new PassThrough()
  const frames = []
  let pending = ''
  toPet.setEncoding('utf8')
  toPet.on('data', (chunk) => {
    pending += chunk
    let index
    while ((index = pending.indexOf('\n')) !== -1) {
      frames.push(JSON.parse(pending.slice(0, index)))
      pending = pending.slice(index + 1)
    }
  })
  let exit
  const done = new Promise((resolve, reject) => {
    exit = { resolve, reject }
  })
  const terminate = mock.fn(() => exit.resolve({ exitCode: null, signal: 'SIGTERM' }))
  return {
    handle: { stdin: toPet, stdout: fromPet, done, terminate },
    frames,
    exit,
    terminate,
    write: (frame) => fromPet.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`),
  }
}

/**
 * 假的 DSH ctx：只实现插件用到的那几个服务，行为按 dsh 的类型声明来。
 * - subprocess.spawn 每次给一个新进程；h.handle / h.frames / h.pet 等指向最新的那个
 * - agents.resume 对不存在的 id 抛 SessionPersistenceNotFoundError
 * - workspaceRegistry.create 按规范化路径复用
 * - sessionTitle.rename 之后来源变成 user
 * - commands.register 返回注销函数，h.run(name) 模拟用户在 Web UI 输入斜杠命令
 */
function harness(options = {}) {
  const {
    persisted = [],
    workspaces = [],
    titles = {},
    headerCwd,
    attachError,
    resumeError,
    resumeGate,
  } = options

  const processes = []
  const latest = () => processes.at(-1)

  const listeners = new Map()
  const disposers = []
  const commands = new Map()
  const live = new Map()
  const stored = new Set(persisted)
  const titleStore = new Map(Object.entries(titles))
  const registered = [...workspaces]
  const calls = { spawn: [], resume: [], create: [], wsCreate: [], attach: [], rename: [], followup: [], dispose: [] }

  function open(id, cwd) {
    const header = headerCwd === null ? {} : { cwd: headerCwd ?? cwd }
    const agent = { session: { id, header }, followup: (message) => calls.followup.push(message) }
    live.set(id, agent)
    return {
      agent,
      dispose: async () => {
        calls.dispose.push(id)
        live.delete(id)
      },
    }
  }

  const ctx = {
    subprocess: {
      spawn(spawnOptions) {
        calls.spawn.push(spawnOptions)
        const proc = fakeProcess()
        processes.push(proc)
        return proc.handle
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
        if (commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov', model: 'mod' }) },
    agents: {
      get: (id) => live.get(id),
      async resume({ resumeSessionId, agentOptions }) {
        calls.resume.push({ resumeSessionId, agentOptions })
        if (resumeGate !== undefined) await resumeGate.promise
        if (resumeError !== undefined) throw resumeError
        if (!stored.has(resumeSessionId)) throw notFound()
        return open(resumeSessionId, options.storedCwd)
      },
      async create({ sessionId, meta, agentOptions }) {
        calls.create.push({ sessionId, meta, agentOptions })
        stored.add(sessionId)
        return open(sessionId, meta.cwd)
      },
    },
    workspaceRegistry: {
      list: () => registered.map((path) => ({ path })),
      async create(path, title) {
        calls.wsCreate.push({ path, title })
        const canonical = await realpath(path)
        if (!registered.includes(canonical)) registered.push(canonical)
        return {
          path: canonical,
          async attachSession(id) {
            calls.attach.push({ path: canonical, id })
            if (attachError !== undefined) throw attachError
          },
        }
      },
    },
    sessionTitle: {
      get: (session) => titleStore.get(session.id),
      rename(session, title) {
        calls.rename.push({ id: session.id, title })
        const snapshot = { title, source: { kind: 'user' } }
        titleStore.set(session.id, snapshot)
        return snapshot
      },
    },
  }

  const h = {
    ctx,
    processes,
    get handle() { return latest().handle },
    get frames() { return latest().frames },
    get exit() { return latest().exit },
    get terminate() { return latest().terminate },
    calls,
    live,
    listeners,
    commands,
    registered,
    pet: (frame) => latest().write(frame),
    emit: (name, ...args) => listeners.get(name)?.(...args),
    run: (name) => {
      const command = commands.get(name)
      if (command === undefined) throw new Error(`没有注册命令 /${name}`)
      return command.handler({ rawInput: '', attachments: [], signal: new AbortController().signal })
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers) await dispose()
    },
  }
  let disposed = false
  harnesses.push(h)
  return h
}

/** 每个测试结束都卸载它建的插件实例：结束假进程、清掉握手计时器，不让它们拖到后面的测试。 */
const harnesses = []
afterEach(async () => {
  // 先让后台还在走的打开会话（含真实的 realpath IO）落定，日志才不会漏到 mock 之外。
  if (harnesses.length > 0) await new Promise((resolve) => setTimeout(resolve, 20))
  for (const h of harnesses.splice(0)) await h.dispose()
})

let base
let realDir
let linkDir
before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'desk-pet-test-')))
  realDir = join(base, 'project')
  linkDir = join(base, 'project-link')
  await mkdir(realDir)
  await symlink(realDir, linkDir)
})
after(async () => {
  await rm(base, { recursive: true, force: true })
})

let logs
const savedEnv = {}
beforeEach(() => {
  logs = []
  for (const key of ['DSH_PET_SELFTEST', 'DSH_HOME']) savedEnv[key] = process.env[key]
  delete process.env.DSH_PET_SELFTEST
  mock.method(process.stderr, 'write', (chunk) => {
    logs.push(String(chunk))
    return true
  })
})
afterEach(() => {
  mock.restoreAll()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const config = (extra = {}) => ({ electron: '/fake/electron', cwd: realDir, ...extra })
const logged = (text) => logs.some((line) => line.includes(text))
const errorFrames = (h) => h.frames.filter((frame) => frame.type === 'error')

/** 走一遍握手，等到 settled 成立（默认：标题已固定，即打开和归位都做完了）。 */
async function connect(h, settled = () => h.calls.rename.length > 0) {
  h.pet({ type: 'ready', pid: 1 })
  await until(settled, '会话打开并归位')
}

describe('desk-pet 插件声明', () => {
  test('依赖里包含 workspaceRegistry 和 sessionTitle', () => {
    for (const name of ['agents', 'subprocess', 'agentDefaultModel', 'workspaceRegistry', 'sessionTitle', 'commands']) {
      assert.ok(inject.includes(name), name)
    }
  })
})

describe('desk-pet 配置校验', () => {
  const bad = [
    [{ skin: 'foo' }, /skin=foo 不支持，可选值：avatar \/ whale/],
    [{ skin: '' }, /skin= 不支持/],
    [{ skin: 1 }, /skin=1 不支持/],
    [{ sessionId: '' }, /sessionId 必须是非空字符串/],
    [{ sessionId: '   ' }, /sessionId 必须是非空字符串/],
    [{ sessionId: 7 }, /sessionId 必须是非空字符串，当前是 7/],
    [{ title: '' }, /title 必须是非空字符串/],
    [{ title: null }, /title 必须是非空字符串，当前是 null/],
    [{ projectDir: '' }, /projectDir 必须是非空字符串/],
    [{ cwd: {} }, /cwd 必须是非空字符串/],
    [{ electron: '' }, /electron 必须是非空字符串/],
  ]
  for (const [extra, pattern] of bad) {
    test(`${JSON.stringify(extra)} 加载失败且不拉起桌宠`, async () => {
      const h = harness()
      await assert.rejects(apply(h.ctx, config(extra)), pattern)
      assert.equal(h.calls.spawn.length, 0)
    })
  }

  test('合法皮肤通过环境变量传给桌宠，没配皮肤就不传', async () => {
    const whale = harness()
    await apply(whale.ctx, config({ skin: 'whale' }))
    assert.equal(whale.calls.spawn[0].env.DSH_PET_SKIN, 'whale')

    const plain = harness()
    await apply(plain.ctx, config())
    assert.equal('DSH_PET_SKIN' in plain.calls.spawn[0].env, false)
  })

  test('不传 config 也能加载（全部走默认值）', async () => {
    const h = harness()
    // electron 走真实的依赖解析；项目已安装 electron。
    await apply(h.ctx)
    assert.equal(h.calls.spawn.length, 1)
    assert.equal(typeof h.calls.spawn[0].argv[0], 'string')
  })
})

describe('desk-pet 拉起桌宠', () => {
  test('argv、cwd、stdio 符合受管模式约定', async () => {
    const h = harness()
    await apply(h.ctx, config({ projectDir: '/opt/pet' }))
    const spawn = h.calls.spawn[0]
    assert.deepEqual(spawn.argv, ['/fake/electron', '/opt/pet', '--bridge-stdio'])
    assert.equal(spawn.cwd, '/opt/pet')
    assert.deepEqual(spawn.stdio, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  })

  test('透传 DSH_HOME 和 DSH_PET_SELFTEST，不透传其它变量', async () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    process.env.DSH_PET_SELFTEST = '1'
    const h = harness()
    await apply(h.ctx, config())
    assert.deepEqual(h.calls.spawn[0].env, { DSH_HOME: '/tmp/dsh-home', DSH_PET_SELFTEST: '1' })
  })

  test('桌宠异常退出、被信号结束、拉起失败都会记日志；正常退出不记', async () => {
    const cases = [
      [(h) => h.exit.resolve({ exitCode: 1, signal: null }), '桌宠进程异常退出 code=1'],
      [(h) => h.exit.resolve({ exitCode: null, signal: 'SIGKILL' }), '桌宠进程被信号结束 signal=SIGKILL'],
      [(h) => h.exit.reject(new Error('ENOENT electron')), '桌宠进程拉起失败 ENOENT electron'],
    ]
    for (const [trigger, text] of cases) {
      const h = harness()
      await apply(h.ctx, config())
      trigger(h)
      await until(() => logged(text), text)
    }

    logs.length = 0
    const ok = harness()
    await apply(ok.ctx, config())
    ok.exit.resolve({ exitCode: 0, signal: null })
    await until(() => logged('桌宠已关闭，在 Web UI 输入 /pet 可以重新打开'), '关闭提示')
    assert.equal(logged('桌宠进程'), false)
  })
})

describe('desk-pet 握手与打开会话', () => {
  test('首次连接：回 ready，新建会话（带 cwd 和模型），登记工作区，固定标题', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await connect(h)

    assert.deepEqual(h.frames[0], { type: 'ready', sessionId: 'desk-pet' })
    assert.equal(h.calls.resume.length, 1)
    assert.deepEqual(h.calls.create, [
      { sessionId: 'desk-pet', meta: { cwd: realDir }, agentOptions: { provider: 'prov', model: 'mod' } },
    ])
    assert.deepEqual(h.calls.wsCreate, [{ path: realDir, title: 'project' }])
    assert.deepEqual(h.calls.attach, [{ path: realDir, id: 'desk-pet' }])
    assert.deepEqual(h.calls.rename, [{ id: 'desk-pet', title: '桌宠' }])
    assert.ok(logged(`已登记工作区 ${realDir}`))
    assert.deepEqual(errorFrames(h), [])
  })

  test('已有会话：直接恢复，不新建；按会话自己记录的目录归位', async () => {
    const h = harness({ persisted: ['desk-pet'], storedCwd: realDir })
    await apply(h.ctx, config({ cwd: '/somewhere/else' }))
    await connect(h)
    assert.equal(h.calls.create.length, 0)
    assert.deepEqual(h.calls.attach, [{ path: realDir, id: 'desk-pet' }])
    assert.ok(logged('恢复会话 desk-pet prov mod'))
  })

  test('工作区已登记（通过软链接访问同一目录）：复用，不报「已登记」', async () => {
    const h = harness({ workspaces: [realDir], headerCwd: linkDir })
    await apply(h.ctx, config())
    await connect(h)
    assert.deepEqual(h.calls.attach, [{ path: realDir, id: 'desk-pet' }])
    assert.deepEqual(h.registered, [realDir])
    assert.equal(logged('已登记工作区'), false)
  })

  test('用户在 Web UI 手动改过名：不覆盖', async () => {
    const h = harness({ persisted: ['desk-pet'], storedCwd: realDir, titles: { 'desk-pet': { title: '我的助手', source: { kind: 'user' } } } })
    await apply(h.ctx, config())
    await connect(h, () => h.calls.attach.length === 1)
    // attach 之后同步检查标题，再多等几拍确认没有迟到的 rename。
    for (let i = 0; i < 5; i += 1) await tick()
    assert.deepEqual(h.calls.rename, [])
  })

  test('标题来自自动生成（provider / fallback）：改成配置的标题', async () => {
    for (const kind of ['provider', 'fallback']) {
      const h = harness({ persisted: ['desk-pet'], storedCwd: realDir, titles: { 'desk-pet': { title: '收到', source: { kind } } } })
      await apply(h.ctx, config({ title: '小鲸鱼' }))
      await connect(h)
      assert.deepEqual(h.calls.rename, [{ id: 'desk-pet', title: '小鲸鱼' }], kind)
    }
  })

  test('自定义 sessionId 生效', async () => {
    const h = harness()
    await apply(h.ctx, config({ sessionId: 'my-pet' }))
    await connect(h)
    assert.deepEqual(h.frames[0], { type: 'ready', sessionId: 'my-pet' })
    assert.equal(h.calls.create[0].sessionId, 'my-pet')
  })

  test('恢复失败但不是「不存在」：不新建（不覆盖历史），报「打开会话失败」', async () => {
    const locked = Object.assign(new Error('session is locked'), { name: 'SessionLockedError' })
    const h = harness({ persisted: ['desk-pet'], resumeError: locked })
    await apply(h.ctx, config())
    h.pet({ type: 'ready', pid: 1 })
    await until(() => errorFrames(h).length > 0, '错误帧')
    assert.equal(h.calls.create.length, 0)
    assert.deepEqual(errorFrames(h), [{ type: 'error', label: '打开会话失败', message: 'session is locked' }])

    // 之后的 prompt 会重新尝试打开，失败照样报出来，而不是卡死在第一次的 Promise 上。
    h.pet({ type: 'prompt', text: 'hi' })
    await until(() => errorFrames(h).length > 1, '第二个错误帧')
    assert.deepEqual(errorFrames(h)[1], { type: 'error', label: '发送失败', message: 'session is locked' })
    assert.equal(h.calls.resume.length, 2)
  })
})

describe('desk-pet 自检模式', () => {
  test('用独立会话和标题，忽略配置的 sessionId / title，不进工作区', async () => {
    process.env.DSH_PET_SELFTEST = '1'
    const h = harness()
    await apply(h.ctx, config({ sessionId: 'desk-pet', title: '桌宠' }))
    await connect(h)
    assert.deepEqual(h.frames[0], { type: 'ready', sessionId: 'desk-pet-selftest' })
    assert.equal(h.calls.create[0].sessionId, 'desk-pet-selftest')
    assert.deepEqual(h.calls.wsCreate, [])
    assert.deepEqual(h.calls.attach, [])
    assert.deepEqual(h.calls.rename, [{ id: 'desk-pet-selftest', title: '桌宠自检' }])
  })

  test('DSH_PET_SELFTEST 为空串也算开启', async () => {
    process.env.DSH_PET_SELFTEST = ''
    const h = harness()
    await apply(h.ctx, config())
    h.pet({ type: 'ready', pid: 1 })
    await until(() => h.frames.length > 0, 'ready')
    assert.equal(h.frames[0].sessionId, 'desk-pet-selftest')
  })
})

describe('desk-pet 归入侧边栏失败不影响聊天', () => {
  const failures = [
    ['attachSession 抛错', { attachError: new Error('cwd mismatch') }, 'cwd mismatch'],
    ['会话没有记录工作目录', { headerCwd: null }, '没有记录工作目录'],
    ['工作目录已被删除', { headerCwd: '/definitely/not/here' }, 'ENOENT'],
  ]
  for (const [name, options, text] of failures) {
    test(`${name}：报「没能放进侧边栏」，消息照常投递`, async () => {
      const h = harness(options)
      await apply(h.ctx, config())
      h.pet({ type: 'ready', pid: 1 })
      h.pet({ type: 'prompt', text: '你好' })
      await until(() => h.calls.followup.length === 1, '消息投递')
      const errors = errorFrames(h)
      assert.equal(errors.length, 1)
      assert.equal(errors[0].label, '没能放进侧边栏')
      assert.ok(errors[0].message.includes(text), errors[0].message)
      assert.ok(logged('归入侧边栏失败'))
    })
  }

  test('归位时改标题失败（标题非法）：同样只报错，消息照常投递', async () => {
    const h = harness()
    h.ctx.sessionTitle.rename = () => {
      throw Object.assign(new Error('title normalizes to empty'), { name: 'SessionTitleInvalidError' })
    }
    await apply(h.ctx, config())
    h.pet({ type: 'ready', pid: 1 })
    h.pet({ type: 'prompt', text: '你好' })
    await until(() => h.calls.followup.length === 1, '消息投递')
    assert.equal(errorFrames(h)[0].label, '没能放进侧边栏')
  })
})

describe('desk-pet 消息投递', () => {
  test('ready 和多条 prompt 同时到达：只打开一次会话，按顺序投递，rpcId 互不相同', async () => {
    const h = harness()
    await apply(h.ctx, config())
    h.pet(
      `${JSON.stringify({ type: 'ready', pid: 1 })}\n`
      + `${JSON.stringify({ type: 'prompt', text: '第一条' })}\n`
      + `${JSON.stringify({ type: 'prompt', text: '第二条' })}\n`,
    )
    await until(() => h.calls.followup.length === 2, '两条消息')
    assert.equal(h.calls.resume.length, 1)
    assert.equal(h.calls.create.length, 1)
    const texts = h.calls.followup.map((message) => message.content[0].text)
    assert.deepEqual(texts, ['第一条', '第二条'])
    const ids = h.calls.followup.map((message) => message.source.rpcId)
    assert.notEqual(ids[0], ids[1])
    assert.ok(h.calls.followup.every((message) => message.role === 'user' && message.source.kind === 'user'))
  })

  test('会话打开后再发消息不会重复 resume', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await connect(h)
    h.pet({ type: 'prompt', text: 'a' })
    h.pet({ type: 'prompt', text: 'b' })
    await until(() => h.calls.followup.length === 2, '两条消息')
    assert.equal(h.calls.resume.length, 1)
  })

  test('消息去掉首尾空白；空白消息不投递也不打开会话', async () => {
    const h = harness()
    await apply(h.ctx, config())
    h.pet({ type: 'prompt', text: '   \n\t ' })
    h.pet({ type: 'prompt', text: '' })
    await tick()
    await tick()
    assert.equal(h.calls.resume.length, 0)
    assert.deepEqual(errorFrames(h), [])

    h.pet({ type: 'prompt', text: '  有内容  \n' })
    await until(() => h.calls.followup.length === 1, '投递')
    assert.equal(h.calls.followup[0].content[0].text, '有内容')
  })

  test('text 不是字符串的 prompt 帧被忽略', async () => {
    const h = harness()
    await apply(h.ctx, config())
    for (const text of [42, null, undefined, { a: 1 }, ['x']]) h.pet({ type: 'prompt', text })
    await tick()
    await tick()
    assert.equal(h.calls.resume.length, 0)
    assert.equal(h.calls.followup.length, 0)
  })

  test('坏帧、非对象帧、未知类型、CRLF、拆包都不影响后续帧', async () => {
    const h = harness()
    await apply(h.ctx, config())
    h.pet('not json\nnull\n123\n"str"\n[]\n{"type":"unknown"}\n\r\n   \n')
    h.pet('{"type":"rea')
    await tick()
    h.pet('dy","pid":9}\r\n')
    await until(() => h.frames.some((frame) => frame.type === 'ready'), 'ready')
    assert.ok(logged('丢弃无法解析的帧'))
    assert.ok(logged('桌宠已连接 pid=9'))
  })
})

describe('desk-pet 事件转发', () => {
  test('只转发桌宠自己的会话事件和状态', async () => {
    const h = harness()
    await apply(h.ctx, config())
    h.emit('session/event', { id: 'other' }, { type: 'turn/start' })
    h.emit('session/event', { id: 'desk-pet' }, { type: 'turn/start' })
    h.emit('agent/status', { agent: { session: { id: 'other' } }, status: 'running' })
    h.emit('agent/status', { agent: { session: { id: 'desk-pet' } }, status: 'running' })
    await tick()
    assert.deepEqual(h.frames, [
      { type: 'session-event', event: { type: 'turn/start' } },
      { type: 'status', status: 'running' },
    ])
  })

  test('桌宠先退出（EPIPE、管道关闭）后继续有事件：不抛异常', async () => {
    const h = harness()
    await apply(h.ctx, config())
    assert.doesNotThrow(() => h.handle.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
    assert.ok(logged('桌宠输入通道断开 write EPIPE'))
    h.handle.stdin.destroy()
    assert.doesNotThrow(() => h.emit('session/event', { id: 'desk-pet' }, { type: 'turn/start' }))
    assert.doesNotThrow(() => h.emit('agent/status', { agent: { session: { id: 'desk-pet' } }, status: 'idle' }))
  })
})

describe('desk-pet 卸载', () => {
  test('结束桌宠、还回会话、取消事件监听', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await connect(h)
    await h.dispose()
    assert.equal(h.terminate.mock.callCount(), 1)
    assert.deepEqual(h.calls.dispose, ['desk-pet'])
    assert.equal(h.listeners.size, 0)
    assert.equal(h.live.size, 0)
  })

  test('从没打开过会话时卸载：只结束桌宠，不报错', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await h.dispose()
    assert.equal(h.terminate.mock.callCount(), 1)
    assert.deepEqual(h.calls.dispose, [])
  })

  test('打开会话途中被卸载：打开完成后立刻还回会话，不泄漏', async () => {
    const resumeGate = gate()
    const h = harness({ persisted: ['desk-pet'], storedCwd: realDir, resumeGate })
    await apply(h.ctx, config())
    h.pet({ type: 'ready', pid: 1 })
    await until(() => h.calls.resume.length === 1, 'resume 开始')
    await h.dispose()
    resumeGate.open()
    await until(() => h.calls.dispose.length === 1, '会话被还回')
    assert.equal(h.live.size, 0)
    assert.deepEqual(h.calls.attach, [])
    assert.deepEqual(h.calls.rename, [])
  })

  test('卸载之后到达的 prompt 不再打开会话', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await h.dispose()
    h.pet({ type: 'prompt', text: 'hi' })
    await until(() => logged('prompt 失败 desk-pet: 插件已卸载'), '拒绝')
    assert.equal(h.calls.resume.length, 0)
  })

  test('注销 /pet 命令，只结束当前那个桌宠进程', async () => {
    const h = harness()
    await apply(h.ctx, config())
    h.exit.resolve({ exitCode: 0, signal: null })
    await tick()
    const reopening = h.run('pet')
    h.pet({ type: 'ready', pid: 2 })
    await reopening
    await h.dispose()
    assert.equal(h.commands.size, 0)
    assert.equal(h.processes[0].terminate.mock.callCount(), 0)
    assert.equal(h.processes[1].terminate.mock.callCount(), 1)
  })
})

/** 让第一个桌宠进程正常退出（用户点了关闭），等插件看到。 */
async function closePet(h, outcome = { exitCode: 0, signal: null }) {
  h.exit.resolve(outcome)
  await tick()
  await tick()
}

describe('desk-pet /pet 重新打开', () => {
  afterEach(() => mock.timers.reset())

  test('注册了合法的全局斜杠命令', async () => {
    const h = harness()
    await apply(h.ctx, config())
    const command = h.commands.get('pet')
    assert.ok(command !== undefined)
    assert.match(command.name, /^[a-z][a-z0-9_-]*$/u)
    assert.ok(command.description.length > 0)
  })

  test('桌宠开着：不再拉起新进程，把它叫到最前面', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await connect(h)
    const result = await h.run('pet')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已经在桌面上/)
    assert.equal(h.processes.length, 1)
    await until(() => h.frames.some((frame) => frame.type === 'show'), 'show 帧')
  })

  test('关闭后 /pet：用同样的参数拉起新进程，连上之后才回复成功', async () => {
    const h = harness()
    await apply(h.ctx, config({ skin: 'whale' }))
    await closePet(h)
    let settled = false
    const reopening = h.run('pet').then((result) => {
      settled = true
      return result
    })
    await until(() => h.processes.length === 2, '新进程')
    await tick()
    assert.equal(settled, false, '握手之前不能回复成功')
    h.pet({ type: 'ready', pid: 2 })
    const result = await reopening
    assert.deepEqual(result, { kind: 'success', text: '桌宠已重新打开' })
    assert.deepEqual(h.calls.spawn[1], h.calls.spawn[0])
    assert.deepEqual(h.frames[0], { type: 'ready', sessionId: 'desk-pet' })
  })

  test('崩溃（非零退出）或被信号结束后也能用 /pet 拉起', async () => {
    for (const outcome of [{ exitCode: 1, signal: null }, { exitCode: null, signal: 'SIGKILL' }]) {
      const h = harness()
      await apply(h.ctx, config())
      await closePet(h, outcome)
      const reopening = h.run('pet')
      await until(() => h.processes.length === 2, '新进程')
      h.pet({ type: 'ready', pid: 2 })
      assert.equal((await reopening).kind, 'success')
    }
  })

  test('重新打开后沿用同一个会话，不重复 resume；事件只发给新进程', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await connect(h)
    const first = h.processes[0]
    const opened = h.calls.resume.length + h.calls.create.length
    await closePet(h)
    const reopening = h.run('pet')
    await until(() => h.processes.length === 2, '新进程')
    h.pet({ type: 'ready', pid: 2 })
    await reopening
    await tick()
    assert.equal(h.calls.resume.length + h.calls.create.length, opened, '会话还活着，不该再 resume/create')

    const before = first.frames.length
    h.emit('session/event', { id: 'desk-pet' }, { type: 'turn/start' })
    await tick()
    assert.equal(first.frames.length, before, '旧进程不该再收到帧')
    assert.deepEqual(h.frames.at(-1), { type: 'session-event', event: { type: 'turn/start' } })

    h.pet({ type: 'prompt', text: '回来了' })
    await until(() => h.calls.followup.length === 1, '投递')
  })

  test('连续执行 /pet：只拉起一个进程，每次都等它连上再回复「已重新打开」', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await closePet(h)
    const runs = [h.run('pet'), h.run('pet'), h.run('pet')]
    await until(() => h.processes.length === 2, '新进程')
    h.pet({ type: 'ready', pid: 2 })
    const results = await Promise.all(runs)
    assert.equal(h.processes.length, 2)
    // 后两次不能抢在握手前回「已经在桌面上了」，那时桌宠还没出现。
    assert.deepEqual(results.map((result) => result.text), Array(3).fill('桌宠已重新打开'))
    assert.equal(h.frames.some((frame) => frame.type === 'show'), false)
  })

  test('新进程在连上之前退出：/pet 报错；之后再执行能重新拉起', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await closePet(h)
    const failing = h.run('pet')
    await until(() => h.processes.length === 2, '第二个进程')
    h.exit.resolve({ exitCode: 1, signal: null })
    const failed = await failing
    assert.equal(failed.kind, 'error')
    assert.match(failed.text, /桌宠没能打开：桌宠进程在连上之前就退出了（code=1/)

    const retry = h.run('pet')
    await until(() => h.processes.length === 3, '第三个进程')
    h.pet({ type: 'ready', pid: 3 })
    assert.equal((await retry).kind, 'success')
  })

  test('新进程拉起失败（如 Electron 被删）：/pet 报出原因', async () => {
    const h = harness()
    await apply(h.ctx, config())
    await closePet(h)
    const failing = h.run('pet')
    await until(() => h.processes.length === 2, '第二个进程')
    h.exit.reject(new Error('spawn ENOENT'))
    const result = await failing
    assert.deepEqual(result, { kind: 'error', text: '桌宠没能打开：spawn ENOENT' })
  })

  test('新进程一直不握手：超时报错，并结束那个进程', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    await apply(h.ctx, config())
    await closePet(h)
    const failing = h.run('pet')
    await until(() => h.processes.length === 2, '第二个进程')
    mock.timers.tick(19_999)
    await tick()
    assert.equal(h.terminate.mock.callCount(), 0)
    mock.timers.tick(1)
    const result = await failing
    assert.equal(result.kind, 'error')
    assert.match(result.text, /20 秒内没有连上/)
    assert.equal(h.terminate.mock.callCount(), 1)
  })

  test('启动时那次自动拉起超时：只记日志、结束进程，不产生未处理的拒绝', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const unhandled = []
    const onUnhandled = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const h = harness()
      await apply(h.ctx, config())
      mock.timers.tick(20_000)
      await tick()
      await tick()
      assert.equal(h.terminate.mock.callCount(), 1)
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('握手成功后计时器已清掉：过了超时时间也不会被误杀', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    await apply(h.ctx, config())
    h.pet({ type: 'ready', pid: 1 })
    await until(() => h.frames.length > 0, 'ready')
    mock.timers.tick(60_000)
    await tick()
    assert.equal(h.terminate.mock.callCount(), 0)
  })

  test('旧进程留下的半截数据不会串到新进程', async () => {
    const h = harness()
    await apply(h.ctx, config())
    h.pet('{"type":"prom')
    await closePet(h)
    const reopening = h.run('pet')
    await until(() => h.processes.length === 2, '新进程')
    h.pet('{"type":"ready","pid":2}\n')
    assert.equal((await reopening).kind, 'success')
    assert.equal(logged('丢弃无法解析的帧'), false)
  })

  test('卸载过程中执行 /pet：报错，不拉起新进程', async () => {
    const h = harness()
    await apply(h.ctx, config())
    const command = h.commands.get('pet')
    await h.dispose()
    const result = await command.handler({})
    assert.equal(result.kind, 'error')
    assert.equal(h.processes.length, 1)
  })
})
