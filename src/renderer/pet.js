/**
 * 渲染层：只做两件事，把状态画成动作，把输入交给主进程。
 * 不直接碰网络，也不直接碰 DSH。
 */
const bubble = document.getElementById('bubble')
const bubbleLabel = document.getElementById('bubbleLabel')
const bubbleText = document.getElementById('bubbleText')
const composer = document.getElementById('composer')
const input = document.getElementById('input')
const sendBtn = document.getElementById('sendBtn')
const talkBtn = document.getElementById('talkBtn')
const closeBtn = document.getElementById('closeBtn')

const IDLE_BUBBLE_TTL_MS = 5_000

// 皮肤由主进程经 query 传入，并已在主进程校验过取值。
const skin = new URLSearchParams(location.search).get('skin')
if (skin === null) throw new Error('页面缺少 skin 参数，应由主进程 loadFile 传入')
document.body.dataset.skin = skin
/** 打字机总时长上限：长回复按比例加速，不让用户干等几十秒。 */
const TYPE_MAX_DURATION_MS = 2_400
const TYPE_TICK_MS = 16

let hideTimer
let typeTimer
/** 打字机结束后要执行的动作（通常是开始 TTL 计时），idle 比打字先到时挂在这里。 */
let afterTyping

function clearHideTimer() {
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer)
    hideTimer = undefined
  }
}

function stopTyping() {
  if (typeTimer !== undefined) {
    clearInterval(typeTimer)
    typeTimer = undefined
  }
  afterTyping = undefined
}

function setText(text) {
  stopTyping()
  bubbleLabel.textContent = ''
  bubbleText.textContent = text
  bubble.hidden = text.length === 0
  scrollToEnd()
}

function setLabeled(label, text) {
  stopTyping()
  bubbleLabel.textContent = label
  bubbleText.textContent = text
  bubble.hidden = label.length === 0 && text.length === 0
  scrollToEnd()
}

function typeOut(text) {
  stopTyping()
  bubbleLabel.textContent = ''
  bubbleText.textContent = ''
  bubble.hidden = false
  const chars = Array.from(text)
  const perTick = Math.max(1, Math.ceil(chars.length / (TYPE_MAX_DURATION_MS / TYPE_TICK_MS)))
  let index = 0
  typeTimer = setInterval(() => {
    index = Math.min(chars.length, index + perTick)
    bubbleText.textContent = chars.slice(0, index).join('')
    scrollToEnd()
    if (index >= chars.length) {
      clearInterval(typeTimer)
      typeTimer = undefined
      const next = afterTyping
      afterTyping = undefined
      next?.()
    }
  }, TYPE_TICK_MS)
}

function scrollToEnd() {
  bubble.scrollTop = bubble.scrollHeight
}

function scheduleHide() {
  clearHideTimer()
  hideTimer = setTimeout(() => {
    bubble.hidden = true
    bubbleText.textContent = ''
    bubbleLabel.textContent = ''
  }, IDLE_BUBBLE_TTL_MS)
}

function handleState(state) {
  if (state === null || typeof state !== 'object') return
  document.body.dataset.state = state.name
  clearHideTimer()

  switch (state.name) {
    case 'thinking':
      setLabeled(state.label ?? '', state.label ? `${state.label}…` : '思考中…')
      break

    case 'working':
      setLabeled(state.label ?? '', '')
      break

    case 'talking':
      if ((state.text ?? '').length > 0) typeOut(state.text)
      break

    case 'error':
      setLabeled(state.label ?? '出错了', state.text ?? '')
      break

    case 'idle':
    default: {
      // talking 和 idle 往往前后脚到：打字机还在跑时，等它写完再开始 TTL，
      // 否则长回复会在打到一半时被收掉。
      if (typeTimer !== undefined) {
        afterTyping = scheduleHide
        break
      }
      const pending = state.text ?? ''
      if (pending.length > 0 && bubbleText.textContent.length === 0) setText(pending)

      if (bubbleText.textContent.length > 0) {
        scheduleHide()
      } else {
        bubble.hidden = true
      }
      break
    }
  }
}

const INPUT_MAX_HEIGHT = 132

/** 文本框随内容长高，到上限后出滚动条。 */
function fitInput() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_HEIGHT)}px`
}

/** 展开前先让主进程把窗口长高，收起后再缩回，避免内容在小窗口里挤一帧。 */
async function setComposerOpen(open) {
  if (open === !composer.hidden) return
  if (open) {
    await window.pet.setComposerOpen(true)
    composer.hidden = false
    fitInput()
    input.focus()
    return
  }
  input.blur()
  composer.hidden = true
  await window.pet.setComposerOpen(false)
}

talkBtn.addEventListener('click', () => {
  setComposerOpen(composer.hidden)
})

closeBtn.addEventListener('click', () => {
  window.pet.quit()
})

document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.pet.openMenu()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setComposerOpen(false)
})

input.addEventListener('input', fitInput)

input.addEventListener('keydown', (event) => {
  // 输入法选字时的回车属于输入法，不能当成发送。
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  composer.requestSubmit()
})

composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (text.length === 0) return

  input.value = ''
  sendBtn.disabled = true
  await setComposerOpen(false)
  document.body.dataset.state = 'thinking'
  setLabeled('', '收到，正在想…')

  try {
    const result = await window.pet.submit(text)
    if (!result?.ok) {
      document.body.dataset.state = 'error'
      setLabeled('没发出去', result?.reason ?? '未知原因')
    }
  } finally {
    sendBtn.disabled = false
  }
})

window.pet.onState(handleState)
window.pet.requestState().then(handleState)
