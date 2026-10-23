/**
 * DSH 侧插件：把桌宠挂到 DSH 的生命周期上。
 *
 * DSH 启动并加载本插件时拉起桌宠进程，DSH 退出或插件卸载时由 subprocess
 * service 负责回收（service disposal 会 terminate 所有受管进程并等它们退出）。
 * 用户关掉桌宠后，在 Web UI 输入 /pet 重新拉起。
 *
 * 桌宠不自己起内核：它只通过这些转发的事件和 prompt 请求跟这里对话。
 * 会话也只有一个，固定 sessionId，桌宠重启不会丢上下文。
 *
 * 会话在 Web UI 侧边栏里要找得到：打开后挂到与其工作目录相同的工作区（没有就登记一个），
 * 并固定标题，不让第一句话决定它叫什么。
 */
import { fileURLToPath } from 'node:url'
import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SKINS } from '../src/rules.mjs'

export const name = 'desk-pet'
// workspaceRegistry 只在 web profile 里提供；桌宠与 dsh web 绑定，缺了就该加载失败。
export const inject = ['agents', 'sessions', 'subprocess', 'agentDefaultModel', 'workspaceRegistry', 'sessionTitle', 'commands']

/** 插件和桌宠在同一个仓库里，默认项目目录就是插件的上一级。 */
const DEFAULT_PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 拉起后等它握手的上限。Electron 冷启动一般 1-3 秒。 */
const READY_TIMEOUT_MS = 20_000

// 诊断走 stderr：DSH 的 logger 有自己出口，排查时不一定看得见。
const log = (...parts) => process.stderr.write(`[desk-pet] ${parts.join(' ')}\n`)

/** 可选的字符串配置项：不填用默认值，填了就必须是非空字符串。 */
function textOption(config, key, fallback) {
  const value = config[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`desk-pet: ${key} 必须是非空字符串，当前是 ${JSON.stringify(value)}`)
  }
  return value
}

export async function apply(ctx, config = {}) {
  // 配置错在插件这一层就报出来，让 DSH 直接显示加载失败，不必等桌宠进程起来再退出。
  if (config.skin !== undefined && !SKINS.includes(config.skin)) {
    throw new Error(`desk-pet: skin=${String(config.skin)} 不支持，可选值：${SKINS.join(' / ')}`)
  }
  const configuredSessionId = textOption(config, 'sessionId', 'desk-pet')
  const configuredTitle = textOption(config, 'title', '桌宠')
  const projectDir = textOption(config, 'projectDir', DEFAULT_PROJECT_DIR)
  const cwd = textOption(config, 'cwd', process.cwd())

  // 自检用独立会话，测试消息不混进用户真正在用的那段对话。
  const selftest = process.env.DSH_PET_SELFTEST !== undefined
  const sessionId = selftest ? 'desk-pet-selftest' : configuredSessionId
  const title = selftest ? '桌宠自检' : configuredTitle

  // 桌宠与 DSH 绑定：找不到 Electron 就让插件加载失败，而不是悄悄跳过。
  let electronPath = textOption(config, 'electron', undefined)
  if (electronPath === undefined) {
    try {
      electronPath = (await import('electron')).default
    } catch (error) {
      throw new Error(`desk-pet: 找不到 Electron，请在 ${projectDir} 执行 npm install：${error.message}`)
    }
  }

  // 桌宠会话的所有者句柄。只有创建者拿得到 dispose，插件卸载时要自己还回去。
  let owned
  let opening
  let disposed = false
  let promptSeq = 0

  // 当前这一个桌宠进程。用户可以关掉它，再用 /pet 重新拉起，所以句柄会换。
  let pet
  let launching

  /**
   * 拉起一个桌宠进程，等它握手成功。
   * 进程在握手前退出、或超时仍没连上，都按失败处理；超时的那个进程会被结束，不留僵尸。
   */
  function launch() {
    const handle = ctx.subprocess.spawn({
      argv: [electronPath, projectDir, '--bridge-stdio'],
      cwd: projectDir,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3_000,
      // subprocess 会清洗父进程里的 DSH_* 变量，桌宠需要的要显式透传。
      env: {
        ...(config.skin === undefined ? {} : { DSH_PET_SKIN: config.skin }),
        ...(process.env.DSH_HOME === undefined ? {} : { DSH_HOME: process.env.DSH_HOME }),
        ...(process.env.DSH_PET_SELFTEST === undefined
          ? {}
          : { DSH_PET_SELFTEST: process.env.DSH_PET_SELFTEST }),
      },
    })
    const current = { handle, exited: false }
    pet = current

    let connected
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`桌宠 ${READY_TIMEOUT_MS / 1000} 秒内没有连上`))
        handle.terminate()
      }, READY_TIMEOUT_MS)
      connected = () => {
        clearTimeout(timer)
        resolve()
      }
      // done 对任何正常退出都 resolve（含非零退出码），只有拉起失败才 reject，两条都要报。
      handle.done.then(
        ({ exitCode, signal }) => {
          current.exited = true
          clearTimeout(timer)
          if (exitCode !== 0 && exitCode !== null) log(`桌宠进程异常退出 code=${exitCode}，原因见上方 [desk-pet] 输出`)
          else if (signal !== null && signal !== undefined) log(`桌宠进程被信号结束 signal=${signal}`)
          else if (!disposed) log('桌宠已关闭，在 Web UI 输入 /pet 可以重新打开')
          reject(new Error(`桌宠进程在连上之前就退出了（code=${exitCode} signal=${signal}）`))
        },
        (error) => {
          current.exited = true
          clearTimeout(timer)
          log('桌宠进程拉起失败', error.message)
          reject(error)
        },
      )
    })
    // 握手结果只有 /pet 关心；启动时自动拉起的那次没人等，失败已经记过日志。
    ready.catch(() => {})

    // 桌宠先退时写 stdin 会 EPIPE，不接住会变成 DSH 进程的未捕获异常。
    handle.stdin?.on('error', (error) => log('桌宠输入通道断开', error.message))

    // 桌宠发来的请求：一行一个 JSON。每个进程一份缓冲，旧进程的半截数据不会串到新进程。
    let buffer = ''
    handle.stdout?.setEncoding('utf8')
    handle.stdout?.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length === 0) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch (error) {
          log('丢弃无法解析的帧', error.message, line.slice(0, 120))
          continue
        }
        if (frame?.type === 'prompt' && typeof frame.text === 'string') {
          log('收到 prompt', frame.text.slice(0, 40))
          receivePrompt(frame.text).catch((error) => {
            log('prompt 失败', error.message)
            send({ type: 'error', label: '发送失败', message: error.message })
          })
        }
        if (frame?.type === 'ready') {
          log('桌宠已连接 pid=' + String(frame.pid))
          send({ type: 'ready', sessionId })
          connected()
          // 连上就打开会话，侧边栏立刻能看到，不必等第一句话。
          ensureAgent().catch((error) => {
            log('打开会话失败', error.message)
            send({ type: 'error', label: '打开会话失败', message: error.message })
          })
        }
      }
    })

    return ready
  }

  /** 发给当前的桌宠进程；它已经关了就丢弃，事件本来就只是给它看的。 */
  function send(payload) {
    const stdin = pet?.handle.stdin
    if (pet === undefined || pet.exited || stdin === undefined || stdin.destroyed) return
    stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /**
   * /pet 的实现：桌宠还在就叫到前面来，已经关了就重新拉起。
   * 连点几次只拉起一个进程。
   */
  async function reopen() {
    if (disposed) return { kind: 'error', text: '桌宠插件已卸载' }
    if (launching !== undefined) {
      await launching
      return { kind: 'success', text: '桌宠已重新打开' }
    }
    if (pet !== undefined && !pet.exited) {
      send({ type: 'show' })
      return { kind: 'success', text: '桌宠已经在桌面上了，已把它叫到最前面' }
    }
    launching = launch().finally(() => {
      launching = undefined
    })
    await launching
    log('桌宠已通过 /pet 重新打开')
    return { kind: 'success', text: '桌宠已重新打开' }
  }

  launch()

  // 只转发这一个会话的事件，其它会话（编辑器里的、子代理的）不打扰桌宠。
  const offEvent = ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    send({ type: 'session-event', event })
  })

  const offStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (agent.session.id !== sessionId) return
    send({ type: 'status', status })
  })

  // 斜杠命令是全局的：任何会话里输入 /pet 都行，结果只显示给用户，不进模型上下文。
  ctx.effect(() => ctx.commands.register({
    name: 'pet',
    description: '打开桌宠（已经打开就叫到最前面）',
    async handler() {
      try {
        return await reopen()
      } catch (error) {
        return { kind: 'error', text: `桌宠没能打开：${error.message}` }
      }
    },
  }), 'desk-pet.command')

  /** 拿到桌宠会话的 agent；并发的 prompt 共用同一次打开，避免对同一个 id 重复 create/resume。 */
  function ensureAgent() {
    if (disposed) return Promise.reject(new Error('desk-pet: 插件已卸载'))
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return Promise.resolve(live)
    if (opening === undefined) {
      opening = openAgent().finally(() => {
        opening = undefined
      })
    }
    return opening
  }

  async function openAgent() {
    // 不传 agentOptions 的 agent 没有模型路由，会 running 一拍就回 idle、什么都不产出。
    const { provider, model } = ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider, model }

    // 桌宠的会话会被持久化到 $DSH_HOME/sessions，新进程里内存 store 是空的，
    // 所以先按持久化 id 恢复；只有「不存在」才新建，其它失败（格式不兼容、被占用等）原样抛出，
    // 否则会用同一个 id 新建覆盖掉历史。按 name 判断，因为插件解析到的包实例不一定是 DSH 自己那份。
    let opened
    try {
      opened = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
      log('恢复会话', String(sessionId), provider, model)
    } catch (error) {
      if (error?.name !== 'SessionPersistenceNotFoundError') throw error
      opened = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })
      log('新建会话', String(sessionId), provider, model)
    }

    // 打开期间插件被卸载：卸载逻辑已经跑过、看不到这个句柄，得在这里还回去。
    if (disposed) {
      await opened.dispose()
      throw new Error('desk-pet: 插件已卸载')
    }
    owned = opened

    // 归不进侧边栏不影响聊天：报给桌宠和终端，消息照常投递。
    try {
      await placeInSidebar(owned.agent.session)
    } catch (error) {
      log('归入侧边栏失败', error.message)
      send({ type: 'error', label: '没能放进侧边栏', message: error.message })
    }
    return owned.agent
  }

  /**
   * 让会话在侧边栏里有归属、有名字。
   * 工作区按会话自己记录的工作目录匹配（恢复的旧会话可能和当前 cwd 不同）；
   * create 对已登记的路径直接复用，不会重复建，也不改已有标题。
   */
  async function placeInSidebar(session) {
    // 自检会话只定标题、留在 Ungrouped，不往用户的工作区里塞测试会话。
    if (!selftest) await attachToWorkspace(session)

    // 用户在 Web UI 里手动改过名就尊重用户的，不再覆盖。
    const current = ctx.sessionTitle.get(session)
    if (current?.source.kind === 'user') return
    ctx.sessionTitle.rename(session, title)
    log('会话标题', title)
  }

  async function attachToWorkspace(session) {
    const sessionCwd = session.header.cwd
    if (typeof sessionCwd !== 'string' || sessionCwd.length === 0) {
      throw new Error(`desk-pet: 会话 ${String(sessionId)} 没有记录工作目录，无法归入工作区`)
    }
    // 登记表里存的是规范化路径，比较前先解析软链接（如 /tmp -> /private/tmp）。
    const canonical = await realpath(sessionCwd)
    const known = ctx.workspaceRegistry.list().some((item) => item.path === canonical)
    const workspace = await ctx.workspaceRegistry.create(sessionCwd, basename(sessionCwd))
    await workspace.attachSession(session.id)
    if (!known) log('已登记工作区', workspace.path)
  }

  async function receivePrompt(text) {
    const trimmed = text.trim()
    if (trimmed.length === 0) return

    const agent = await ensureAgent()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: trimmed }],
      // 同一毫秒内连发两条也要区分开。
      source: { kind: 'user', rpcId: `desk-pet-${Date.now()}-${++promptSeq}` },
    }))
    log('已投递消息')
  }

  ctx.effect(() => async () => {
    disposed = true
    offEvent()
    offStatus()
    pet?.handle.terminate()
    if (owned !== undefined) await owned.dispose()
  }, 'desk-pet.bridge')
}
