/**
 * 桌宠主进程。
 *
 * 职责很少，故意压薄：一个透明置顶窗口、一条到 DSH 插件的通道、一条状态推送线。
 * 宠物怎么动全在渲染层，内核能力全在 DSH，这里只做搬运。
 *
 * 只能由 DSH 的 desk-pet 插件拉起（argv 带 --bridge-stdio）；直接运行会报错退出。
 */
import { app, BrowserWindow, ipcMain, Menu, screen, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { StdioKernel } from './stdio-kernel.mjs'
import { initialState, reduceEvent, reduceStatus, STATES } from './state.mjs'
import { composerBounds, PET_SIZE, startupError } from './rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKIN = process.env.DSH_PET_SKIN ?? 'avatar'

/**
 * 启动期的致命错误一律写 stderr 并以非零码退出。
 * 不能 throw：Electron 会对未捕获异常弹模态框并一直等人点掉，
 * 由 DSH 拉起时进程就卡在那里，错误也到不了 DSH 的终端。
 */
function die(message) {
  process.stderr.write(`[desk-pet] ${message}\n`)
  app.exit(1)
}

process.on('uncaughtException', (error) => die(`主进程未捕获异常：${error?.stack ?? error}`))
process.on('unhandledRejection', (reason) => die(`主进程未处理的 Promise 拒绝：${reason?.stack ?? reason}`))

let win
let bridge
let petState = initialState()
let bridgeError

async function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    x: workArea.width - PET_SIZE.width - 24,
    y: workArea.height - PET_SIZE.height - 24,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // 渲染层的异常不写主进程日志，转发一份出来，否则只能看到一个安静的白色小窗。
  // 一律走 stderr：受管模式下 stdout 是跟 DSH 插件的协议专线。
  win.webContents.on('console-message', (...args) => {
    const detail = args[1]
    const message = typeof detail === 'object' && detail !== null ? detail.message : args[2]
    if (typeof message === 'string' && message.length > 0) console.error(`[renderer] ${message}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] 进程退出', details?.reason)
  })

  await win.loadFile(join(HERE, 'renderer', 'index.html'), { query: { skin: SKIN } })

  // 调试：DSH_PET_SHOT=/tmp/x.png 时截一张图就退出，用来检查形象而不依赖屏幕录制权限。
  if (process.env.DSH_PET_SHOT !== undefined) {
    setTimeout(async () => {
      const forced = process.env.DSH_PET_SHOT_STATE
      if (forced === 'talking') {
        pushState({ name: STATES.TALKING, label: '', text: '气泡在这里显示它说的话，用来检查排版、换行和高度上限。', at: Date.now() })
      }
      if (forced === 'working') {
        pushState({ name: STATES.WORKING, label: 'ls -la ~/project', text: '', at: Date.now() })
      }
      if (forced === 'thinking') {
        pushState({ name: STATES.THINKING, label: '', text: '思考中…', at: Date.now() })
      }
      if (forced === 'error') {
        pushState({ name: STATES.ERROR, label: '本轮失败 RATE_LIMIT', text: '模型限流，请稍后再试', at: Date.now() })
      }
      if (forced !== undefined) await new Promise((resolve) => setTimeout(resolve, 700))
      // 调试：走真实的点击路径展开输入框，并填入多行文字检查自动长高。
      if (process.env.DSH_PET_SHOT_COMPOSER !== undefined) {
        await win.webContents.executeJavaScript(`
          document.getElementById('talkBtn').click()
          const box = document.getElementById('input')
          box.value = ${JSON.stringify(process.env.DSH_PET_SHOT_COMPOSER)}
          box.dispatchEvent(new Event('input'))
        `)
        await new Promise((resolve) => setTimeout(resolve, 500))
        console.error(`[shot] bounds ${JSON.stringify(win.getBounds())}`)
        // 再按 Esc 收起，确认窗口能缩回原尺寸；截图仍取展开时的样子。
        if (process.env.DSH_PET_SHOT_COMPOSER_CLOSE !== undefined) {
          const opened = await win.capturePage()
          await win.webContents.executeJavaScript(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`,
          )
          await new Promise((resolve) => setTimeout(resolve, 500))
          console.error(`[shot] bounds after esc ${JSON.stringify(win.getBounds())}`)
          await writeFile(process.env.DSH_PET_SHOT, opened.toPNG())
          app.quit()
          return
        }
      }
      try {
        const image = await win.capturePage()
        await writeFile(process.env.DSH_PET_SHOT, image.toPNG())
        console.error(`[shot] ${process.env.DSH_PET_SHOT}`)
      } catch (error) {
        console.error('[shot] 失败', error.message)
      }
      app.quit()
    }, 2_000)
  }
}

function pushState(patch) {
  petState = patch
  if (win !== undefined && !win.isDestroyed()) win.webContents.send('pet:state', petState)
}

/** 只在展开期间放大：透明区域同样会挡住下面应用的鼠标点击。 */
let composerShift = 0
function setComposerBounds(open) {
  const bounds = win.getBounds()
  const next = composerBounds(bounds, screen.getDisplayMatching(bounds).workArea, open, composerShift)
  if (next === null) return
  composerShift = next.shift
  win.setBounds(next.bounds)
}

function applyEvent(notification) {
  const event = notification?.event
  if (event === undefined) return
  const next = reduceEvent(petState, event)
  if (next !== null) pushState(next)
}

function applyStatus(notification) {
  if (notification?.status === undefined) return
  const next = reduceStatus(petState, notification.status)
  if (next !== null) pushState(next)
}

async function startBridge() {
  // 桌宠与 DSH 强绑定：只能由 DSH 的 desk-pet 插件拉起，能力和生命周期都来自那个 DSH 进程。
  bridge = new StdioKernel()

  bridge.on('session-event', applyEvent)
  bridge.on('session-status', applyStatus)
  // prompt 是异步投递的，插件侧失败通过这条回来；label 说明是哪一步出的错。
  bridge.on('prompt-error', (error) => {
    pushState({ name: STATES.ERROR, label: error.label ?? '发送失败', text: error.message, at: Date.now() })
  })
  // DSH 没了就别赖着，跟着退。
  bridge.on('exit', () => app.quit())
  // 用户在 DSH 里执行 /pet 而桌宠本来就开着：叫到最前面，可能被别的窗口挡住了。
  bridge.on('show', () => {
    if (win === undefined || win.isDestroyed()) return
    win.show()
    win.moveTop()
  })

  pushState({ name: STATES.THINKING, label: '正在连接 DSH', text: '', at: Date.now() })
  try {
    await bridge.start()
    pushState(initialState())
    if (process.env.DSH_PET_SELFTEST !== undefined) runSelfTest()
  } catch (error) {
    bridgeError = error
    pushState({ name: STATES.ERROR, label: '连接 DSH 失败', text: error.message, at: Date.now() })
  }
}

/**
 * 自检：发一句真话，等回复落到 talking，截一张图就退。
 * 用来验证「桌宠 <-> 插件 <-> agent」整条链，不用手动点。
 */
async function runSelfTest() {
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  try {
    await bridge.prompt('只回复两个字：收到')
  } catch (error) {
    console.error('[selftest] 发送失败', error.message)
  }

  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (petState.text.length > 0) break
    if (petState.name === STATES.ERROR) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  try {
    const image = await win.capturePage()
    await writeFile('/tmp/pet-selftest.png', image.toPNG())
    process.stderr.write(`[selftest] state=${petState.name} text=${JSON.stringify(petState.text.slice(0, 60))}\n`)
  } catch (error) {
    console.error('[selftest] 截图失败', error.message)
  }
  app.quit()
}

function registerIpc() {
  ipcMain.handle('pet:submit', async (_event, text) => {
    if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, reason: 'empty' }
    if (bridge === undefined || !bridge.alive) {
      return { ok: false, reason: bridgeError?.message ?? '内核未运行' }
    }
    try {
      await bridge.prompt(text)
      return { ok: true }
    } catch (error) {
      pushState({ name: STATES.ERROR, label: '发送失败', text: error.message, at: Date.now() })
      return { ok: false, reason: error.message }
    }
  })

  ipcMain.handle('pet:state', () => petState)

  ipcMain.handle('pet:composer', (_event, open) => {
    if (typeof open !== 'boolean') throw new TypeError('pet:composer 需要 boolean')
    if (win === undefined || win.isDestroyed()) return
    setComposerBounds(open)
  })

  ipcMain.on('pet:menu', () => {
    if (win === undefined || win.isDestroyed()) return
    const menu = Menu.buildFromTemplate([
      {
        label: win.isAlwaysOnTop() ? '取消置顶' : '保持置顶',
        click: () => {
          const next = !win.isAlwaysOnTop()
          win.setAlwaysOnTop(next, 'floating')
        },
      },
      {
        label: '打开 DSH 数据目录',
        click: () => shell.openPath(process.env.DSH_HOME ?? join(app.getPath('home'), '.dsh')),
      },
      { type: 'separator' },
      { label: '关闭桌宠（在 DSH 输入 /pet 重新打开）', click: () => app.quit() },
    ])
    menu.popup({ window: win })
  })

  ipcMain.on('pet:quit', () => app.quit())
}

const managed = process.argv.includes('--bridge-stdio')
const shotOnly = process.env.DSH_PET_SHOT !== undefined

const fatal = startupError({ managed, shotOnly, skin: SKIN })
if (fatal !== undefined) {
  die(fatal)
} else {
  app.whenReady().then(async () => {
    registerIpc()
    await createWindow()
    if (managed) startBridge()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', async (event) => {
  if (bridge === undefined || !bridge.alive) return
  event.preventDefault()
  const dying = bridge
  bridge = undefined
  try {
    await dying.close()
  } catch (error) {
    console.error('[quit] 关停内核失败', error.message)
  } finally {
    app.quit()
  }
})
