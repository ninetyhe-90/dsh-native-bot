/**
 * 会话事件到宠物状态的纯函数映射。
 *
 * 输入是 SDK 的 `session.event` / `session.status` 通知，输出是渲染层要播的状态。
 * 这一层不碰 IPC 也不碰 DOM，方便单独验证。
 */

const IDLE = 'idle'
const THINKING = 'thinking'
const WORKING = 'working'
const TALKING = 'talking'
const ERROR = 'error'

/** 一次工具调用的展示文案，只取对用户有意义的那几个字段。 */
export function describeTool(name, rawArguments) {
  let args
  try {
    args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments
  } catch {
    return name
  }
  if (args === null || typeof args !== 'object') return name

  const command = args.command
  if (typeof command === 'string' && command.length > 0) {
    return truncate(command.replace(/\s+/g, ' '), 48)
  }
  const path = args.path ?? args.file_path ?? args.filePath ?? args.pattern
  if (typeof path === 'string' && path.length > 0) {
    return `${name} ${truncate(path, 36)}`
  }
  return name
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 从 assistant message 的内容块里拼出纯文本。 */
export function assistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('').trim()
}

export function initialState() {
  return { name: IDLE, label: '', text: '', at: Date.now() }
}

/**
 * 单个事件的迁移。返回 `null` 表示这条事件不影响宠物表现。
 *
 * @param {{name: string, label: string, text: string, at: number}} current
 * @param {{type: string, data: unknown}} event
 */
export function reduceEvent(current, event) {
  switch (event.type) {
    case 'turn/start':
    case 'step/start':
      return { name: THINKING, label: '', text: '', at: Date.now() }

    case 'tool/call':
      return {
        name: WORKING,
        label: describeTool(event.data?.name ?? 'tool', event.data?.arguments),
        text: '',
        at: Date.now(),
      }

    case 'tool/result':
      // 失败标志是 message.isError；data.error 只是可选的结构化补充，不能单独作为判据。
      if (event.data?.message?.isError === true) {
        const failure = event.data.error
        return {
          name: ERROR,
          label: failure?.name ?? '工具调用失败',
          text: failure?.reason ?? '',
          at: Date.now(),
        }
      }
      return { name: THINKING, label: '', text: '', at: Date.now() }

    case 'assistant/message': {
      const text = assistantText(event.data?.message)
      if (text.length === 0) return { name: THINKING, label: '', text: '', at: Date.now() }
      return { name: TALKING, label: '', text, at: Date.now() }
    }

    case 'turn/end':
      return reduceTurnEnd(current, event.data?.reason)

    default:
      return null
  }
}

/**
 * turn/end 的 reason 是对象 `{ kind, ... }`，见 dsh-session 的 TurnEndReasonMap。
 * error 带 LlmFailure（message/code），aborted 带取消原因。
 */
function reduceTurnEnd(current, reason) {
  const kind = reason?.kind
  if (kind === 'error') {
    const failure = reason.error
    return {
      name: ERROR,
      label: failure?.code === undefined ? '本轮失败' : `本轮失败 ${failure.code}`,
      text: failure?.message ?? '',
      at: Date.now(),
    }
  }
  if (kind === 'blocked') {
    return { name: ERROR, label: '本轮被拦截', text: '', at: Date.now() }
  }
  if (kind === 'aborted') {
    return { name: IDLE, label: '', text: '', at: Date.now() }
  }
  // completed / max-tokens 等：保留刚说完的那句话，交给渲染层的 TTL 决定何时淡出。
  return { name: IDLE, label: '', text: current.text, at: Date.now() }
}

/** 整机状态迁移：running 进入思考，idle 回到待机。 */
export function reduceStatus(current, status) {
  if (status === 'running') {
    if (current.name === WORKING || current.name === TALKING) return null
    return { name: THINKING, label: '', text: '', at: Date.now() }
  }
  if (status === 'idle') {
    return { name: IDLE, label: '', text: current.text, at: Date.now() }
  }
  return null
}

export const STATES = { IDLE, THINKING, WORKING, TALKING, ERROR }
