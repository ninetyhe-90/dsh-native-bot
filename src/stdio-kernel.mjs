/**
 * 受管模式的内核通道。
 *
 * 桌宠由 DSH 的 desk-pet 插件拉起时走这条：不 spawn 任何内核，只跟父进程
 * 用 stdin/stdout 交换一行一个 JSON。父进程死了 stdin 就 EOF，桌宠跟着退。
 *
 * stdout 是协议专线：桌宠进程里任何诊断输出都必须走 stderr。
 *
 * 协议：
 *   -> { type: 'ready', pid }
 *   -> { type: 'prompt', text }
 *   <- { type: 'ready', sessionId }
 *   <- { type: 'session-event', event }
 *   <- { type: 'status', status }
 *   <- { type: 'error', message, label? }
 *   <- { type: 'show' }            用户在 DSH 里执行了 /pet，而桌宠本来就开着
 */
import { EventEmitter } from 'node:events'

const HANDSHAKE_TIMEOUT_MS = 10_000

export class StdioKernel extends EventEmitter {
  #buffer = ''
  #started = false
  /** 握手完成。超时之后父进程再回 ready 也不算数，主进程已经按连接失败处理了。 */
  #ready = false
  /** 管道已断开或已主动关闭；exit 只发一次。 */
  #closed = false
  #handshake
  #input
  #output
  #timeoutMs

  /**
   * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, handshakeTimeoutMs?: number }} [options]
   *   默认就是本进程的 stdin/stdout；测试时注入内存流和更短的超时。
   */
  constructor({ input = process.stdin, output = process.stdout, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
    super()
    this.#input = input
    this.#output = output
    this.#timeoutMs = handshakeTimeoutMs
  }

  /** 握手成功且管道未断，才能发 prompt。 */
  get alive() {
    return this.#ready && !this.#closed
  }

  /** 发出 ready 并等父进程回 ready；超时或管道先断都会抛错。 */
  async start() {
    if (this.#started) return
    this.#started = true

    const handshake = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#handshake = undefined
        reject(new Error(`等待 DSH 插件回应超时（${this.#timeoutMs}ms）`))
      }, this.#timeoutMs)
      this.#handshake = {
        resolve: () => {
          clearTimeout(timer)
          this.#ready = true
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })

    this.#input.setEncoding('utf8')
    this.#input.on('data', (chunk) => this.#consume(chunk))
    this.#input.on('end', () => this.#disconnect('父进程已关闭'))
    this.#input.on('error', (error) => this.#disconnect(`父进程管道断开：${error.message}`))

    this.#send({ type: 'ready', pid: process.pid })
    await handshake
  }

  async prompt(text) {
    if (this.#closed) throw new Error('父进程已断开')
    if (!this.#ready) throw new Error('尚未与 DSH 插件握手')
    this.#send({ type: 'prompt', text })
  }

  /** 关停由父进程负责，这里只标记状态。 */
  async close() {
    this.#closed = true
  }

  #disconnect(reason) {
    if (this.#closed) return
    this.#closed = true
    const pending = this.#handshake
    this.#handshake = undefined
    pending?.reject(new Error(reason))
    this.emit('exit', { code: 0, stderr: reason })
  }

  #consume(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length === 0) continue
      this.#consumeLine(line)
    }
  }

  #consumeLine(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch (error) {
      process.stderr.write(`[stdio-kernel] 丢弃无法解析的帧：${error.message} ${line.slice(0, 120)}\n`)
      return
    }
    if (frame === null || typeof frame !== 'object') return

    switch (frame.type) {
      case 'ready': {
        const pending = this.#handshake
        this.#handshake = undefined
        pending?.resolve()
        break
      }
      case 'session-event':
        if (frame.event !== undefined) this.emit('session-event', { event: frame.event })
        break
      case 'status':
        if (typeof frame.status === 'string') this.emit('session-status', { status: frame.status })
        break
      case 'error': {
        const error = new Error(typeof frame.message === 'string' ? frame.message : '桌宠桥报错')
        if (typeof frame.label === 'string') error.label = frame.label
        this.emit('prompt-error', error)
        break
      }
      case 'show':
        this.emit('show')
        break
      default:
        break
    }
  }

  #send(payload) {
    this.#output.write(`${JSON.stringify(payload)}\n`)
  }
}
