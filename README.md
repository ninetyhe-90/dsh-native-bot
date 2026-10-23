# DSH Desk Pet

**把 DeepSeek Harness 放到桌面上，看得见它在想、在做、在说。**

给 DeepSeek Harness 的桌宠插件 · 透明置顶小窗 · 事件驱动的 5 种状态 · 两套皮肤 · 随 DSH 启停

适配 **@deepseek-ai/dsh 0.2.1-rc.2** · Electron 45 · [English](docs/README.en.md) · [日本語](docs/README.ja.md) · [한국어](docs/README.ko.md)

![五种状态与鲸鱼皮肤](docs/images/states.png)

---

## 它是什么

DSH Desk Pet 是一个跑在你自己机器上的 DSH 插件。DSH 启动时，它在屏幕右下角拉起一个小窗，把会话里正在发生的事画成角色的动作：

- **看得见进度**：模型在思考、在调用工具、在回复，角色各有一套动作，工具调用会把命令或文件路径显示在气泡里；
- **随手就能问**：点左下角按钮打开输入框，回车发送，不用切回浏览器；
- **同一段对话**：桌宠固定使用 `desk-pet` 会话，Web UI 里能看到同一段记录，重启后自动恢复；
- **出错不沉默**：模型失败、工具被拒、本轮被拦截，角色会发抖并把原因显示出来。

桌宠没有自己的内核。模型配置、会话存储、权限策略都来自拉起它的那个 DSH 进程；DSH 退出，它就跟着退出。

## 设计原则

| 原则 | 含义 |
| --- | --- |
| 绑定 DSH | 只能由 DSH 插件拉起，不另起内核、不自建会话存储；直接运行 Electron 会报错退出 |
| 状态有来源 | 每个动作都对应一条 DSH 会话事件，不随机播放，不靠计时器猜 |
| 错误直接说 | 找不到 Electron、会话恢复失败、皮肤配置写错，都直接报错，不悄悄换成默认值 |
| 渲染层无能力 | 页面只拿到 4 个 IPC 方法，开启 `contextIsolation` 与 CSP，不碰 Node、不碰网络 |

## 安装

在项目目录执行：

```sh
npm install                       # 安装项目内的 DSH 与 Electron，不需要全局 dsh
npm start                         # 等价于 dsh web --patch cordis.patch.yml
```

浏览器打开 `http://127.0.0.1:3080/`，桌宠同时出现在屏幕右下角。额外参数可以透传，例如 `npm start -- --no-open`。

### 挂进你常用的 profile

想让平时的 `dsh web` 也自动带上桌宠，把 `cordis.patch.yml` 里那段 `insert` 追加到 `$DSH_HOME/profiles/web/cordis.patch.yml`，把插件路径改成你本机的绝对路径。

### 安装边界

- `npm start` 只通过 `--patch` 临时叠加插件，**不修改** `$DSH_HOME` 下的任何 profile 文件。
- 插件只订阅 `desk-pet` 这一个会话的事件，**不读取**你其他会话的内容。
- 桌宠进程由 DSH 的 `ctx.subprocess` 管理，DSH 退出或插件卸载时会被终止并回收，不留后台进程。
- 如果 shell 里设了 `NODE_ENV=production`，npm 会跳过开发依赖；Electron 因此放在 `dependencies` 里，装完即可用。

## 操作

| 操作 | 效果 |
| --- | --- |
| 拖动角色 | 移动窗口 |
| 左下角按钮 | 打开 / 收起输入框，回车发送，`Esc` 收起 |
| 右键 | 菜单：置顶开关、打开 DSH 数据目录、退出 |
| 右下角按钮 | 关闭桌宠（DSH 不受影响） |
| Web UI 输入 `/pet` | 重新打开关掉的桌宠；桌宠还开着就把它叫到最前面 |

## 状态从哪来

| 角色 | 动作（avatar 皮肤） | DSH 事件 |
| --- | --- | --- |
| 待机 | 轻轻摆头 | 无事件 |
| 思考 | 歪头，头顶跳动省略号 | `turn/start`、`step/start`、`agent/status=running` |
| 干活 | 快速点头，转动齿轮，气泡显示命令 | `tool/call` |
| 说话 | 弹跳，气泡打字机显示回复 | `assistant/message` |
| 出错 | 发抖、变灰、流汗，气泡显示原因 | `tool/result` 的 `message.isError`；`turn/end` 的 `reason.kind` 为 `error` / `blocked` |

## 配置

在 `cordis.patch.yml` 的插件条目下加 `config`：

```yaml
- insert:
    - id: desk-pet
      name: /path/to/dsh-native-bot/plugin/desk-pet.mjs
      config:
        skin: whale
```

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `skin` | `avatar` | 皮肤：`avatar`（位图头像，整体动）或 `whale`（手绘 SVG 鲸鱼，分部件动）；写错直接报错 |
| `sessionId` | `desk-pet` | 桌宠使用的会话 id |
| `title` | `桌宠` | 会话在 Web UI 侧边栏里的标题；在 Web UI 里手动改过名则以手动的为准 |
| `cwd` | DSH 的工作目录 | 新建会话时的工作目录 |
| `projectDir` | 插件所在仓库 | 桌宠前端所在目录 |
| `electron` | 项目依赖里的 Electron | 指定 Electron 可执行文件 |

桌宠连上 DSH 就会打开会话，并把它挂到与会话工作目录相同的工作区下（没有就自动登记一个），所以 Web UI 侧边栏里能直接找到它、接着在网页上聊。

## 换形象

- **`avatar`**：`src/renderer/avatar.png`，透明底、裁到内容边界、宽 640px 左右。替换这一个文件即可，动作不用改。
- **`whale`**：`src/renderer/index.html` 里的 `<svg>`，渐变填色加 CSS 关键帧，不依赖图片素材。
- 位图只能整体动，眨眼、嘴部开合需要同一角色的闭眼、闭嘴差分图。
- 用别人的作品当形象，自用没问题；公开发布前先确认你有使用权。

## 兼容性

| 组件 | 值 |
| --- | --- |
| DSH | `@deepseek-ai/dsh` 0.2.1-rc.2，随项目依赖安装 |
| Electron | 45.x，只负责界面，不运行 DSH 内核 |
| Node | ≥20.11，用于运行 DSH |
| 系统 | macOS 已验证；Windows / Linux 未验证 |

## 出问题怎么办

```sh
npm test                                      # 语法检查 + 单元测试，不需要 DSH 运行
npm run test:e2e                              # 真实 Electron 集成测试：关闭 -> /pet -> 重新出现，会在桌面短暂弹出桌宠
DSH_PET_SELFTEST=1 npm start -- --no-open     # 端到端自检：用独立会话 desk-pet-selftest 发一句话，截图到 /tmp/pet-selftest.png 后退出
DSH_PET_SHOT=/tmp/pet.png DSH_PET_SHOT_STATE=talking ./node_modules/.bin/electron .
                                              # 只看渲染，不连 DSH；状态可选 thinking / working / talking / error
```

插件和桌宠的诊断信息都以 `[desk-pet]` 开头，打印在启动 DSH 的终端里。3080 打不开时，先确认 `dsh web` 确实在运行；`--patch` 必须紧跟在 `web` 后面。

## 已知限制

- 气泡的打字机是本地模拟，插件还没有接 `agent/assistant-stream` 的逐 token 流；
- 需要审批的工具调用不会在桌宠里弹审批，按 DSH 的策略处理，可以在 Web UI 里审批；
- 窗口固定在主显示器，不跨显示器跟随；
- 动画是 CSS 关键帧，没有骨骼或帧序列。

## 结构

```
plugin/desk-pet.mjs     DSH 侧插件：拉起桌宠、转发事件、投递 prompt、回收进程
cordis.patch.yml        把插件挂进 profile 的 overlay
src/main.mjs            Electron 主进程：窗口、菜单、IPC、启动守卫
src/stdio-kernel.mjs    与插件的通道：stdin/stdout 一行一个 JSON，stdout 是协议专线
src/state.mjs           会话事件 -> 角色状态（纯函数）
src/preload.cjs         渲染层唯一的能力出口
src/renderer/           形象、动画、气泡
```

```sh
npm run check           # 全部源码语法检查
```

关键词：DeepSeek Harness · DSH 插件 · 桌宠 · desktop pet · Electron · 透明窗口 · 会话事件 · 状态机
