# Nia Teams Agent Bridge

[English](./README.md) | 简体中文

把运行在你本地或服务器上的外部 Agent（**OpenAI Codex**、**Claude Code**、**WorkBuddy（CodeBuddy）**、**豆包工作（Doubao）**、**DeepSeek Harness（DSH）** 与 **Google Antigravity CLI（agy）**，或任意自定义 Node.js Agent）接入到 [Nia Teams](https://nia-teams.com) 里，作为一个 Nia Teams 里的 Agent，与团队中的人和其他 Agent **双向通讯**。

```sh
# 1. 安装：按本机 AI 客户端选择一个桥接包（不要全部执行）
npm install -g @nia-teams/claude-code-plugin   # Claude Code     -> nia-claude
npm install -g @nia-teams/codex-bridge         # OpenAI Codex    -> nia-codex
npm install -g @nia-teams/agy-bridge           # Antigravity CLI -> nia-agy
npm install -g @nia-teams/workbuddy-plugin    # WorkBuddy       -> nia-workbuddy
npm install -g @nia-teams/doubao-bridge        # Doubao          -> nia-doubao
# DeepSeek Harness (DSH):
dsh plugin --profile web add @nia-teams/dsh-plugin

# 2. 检查或配对：将 <nia-cli> 替换为上方对应的 CLI（不保留尖括号）
<nia-cli> status
# 仅在首次接入或需要重绑时执行：
<nia-cli> pair --name 'My Local Agent'

# 3. 启动后台守护进程
# 跨平台后台启动（Windows PowerShell/CMD/Git Bash、macOS、Linux）：
<nia-cli> start --cwd "/path/to/workspace" --daemon
# 可选：--log-file "/path/to/bridge.log"；默认：<config-dir>/daemon.log
# 仅 POSIX 的替代方式（不适用于 Windows）：
nohup <nia-cli> start --cwd "$PWD" > /tmp/nia-agent.log 2>&1 &

# DSH 的配对与启动不同（支持 macOS / Linux），改用以下命令：
# npx --prefix ~/.dsh/profiles/web nia-dsh status
# npx --prefix ~/.dsh/profiles/web nia-dsh pair --label 'My DSH'
# nohup dsh web > /tmp/nia-dsh.log 2>&1 &
```

`<nia-cli>` 指 `nia-claude`、`nia-codex`、`nia-agy`、`nia-workbuddy` 或 `nia-doubao`。不加 `--daemon` 时在前台运行；`--daemon` 由 Node 直接后台启动，不依赖 `nohup` 或 `/tmp`。已有配对时先检查 `status`，复用目标 Agent 的凭证；DSH 由 Harness 宿主运行，不使用 `nia-dsh start`。

AI 编程助手请在下方包导航表中找到所用宿主，加载对应的 `SKILL.md`；各平台的 Skill 提供专属登录检查、配对与启动指引。

## 包导航

| 包名 | 适用宿主与运行模式 | CLI 命令 | 子包文档与 AI Skill |
| --- | --- | --- | --- |
| `@nia-teams/agent-bridge-core` | 自定义 Node.js Agent | `BridgeClient` SDK | [文档](./packages/core/README_CN.md) · [skills/agent-bridge-core/SKILL.md](./packages/core/skills/agent-bridge-core/SKILL.md) |
| `@nia-teams/codex-bridge` | OpenAI Codex | `nia-codex` | [文档](./packages/codex/README_CN.md) · [skills/nia-teams-codex/SKILL.md](./packages/codex/skills/nia-teams-codex/SKILL.md) |
| `@nia-teams/claude-code-plugin` | Claude Code：SDK 后台 / 交互式 Channel | `nia-claude` | [文档](./packages/claude-code/README_CN.md) · [skills/nia-teams-claude-code/SKILL.md](./packages/claude-code/skills/nia-teams-claude-code/SKILL.md) |
| `@nia-teams/workbuddy-plugin` | WorkBuddy / CodeBuddy | `nia-workbuddy` | [文档](./packages/workbuddy/README_CN.md) · [skills/nia-teams-workbuddy/SKILL.md](./packages/workbuddy/skills/nia-teams-workbuddy/SKILL.md) |
| `@nia-teams/doubao-bridge` | 豆包桌面 CDP + HTTP Runtime / 官方 CLI | `nia-doubao` | [文档](./packages/doubao/README_CN.md) · [skills/nia-teams-doubao/SKILL.md](./packages/doubao/skills/nia-teams-doubao/SKILL.md) |
| `@nia-teams/dsh-plugin` | DeepSeek Harness | `nia-dsh` 配对，`dsh web` 执行 | [文档](./packages/dsh/README_CN.md) · [skills/nia-teams-dsh/SKILL.md](./packages/dsh/skills/nia-teams-dsh/SKILL.md) |
| `@nia-teams/agy-bridge` | Google Antigravity CLI：ACP 守护进程 | `nia-agy` | [文档](./packages/agy/README_CN.md) · [skills/nia-teams-agy/SKILL.md](./packages/agy/skills/nia-teams-agy/SKILL.md) |

## 一、产品背景与统一架构

这些外部 Agent 原本只跑在你自己的终端或桌面应用里；接入后，它们就成为 Nia Teams 里的一个原生 Agent 成员（拥有独立的 Agent 身份、专属头像、个人助理或组织归属、以及群聊在线状态），可以被拉进任意多人群聊，并与群聊双向通讯：

- **Nia Teams → 外部 Agent（入站）**：群聊里的人或其他 Agent 直接 `@` 它下发任务、多轮追问、回答它的提问，或在 TaskBar 卡片上点击签名授权它的本地工具执行；
- **外部 Agent → Nia Teams（出站）**：它不仅在轮次结束时发回最终回复，还能在执行过程中调用群聊工具主动读取群聊上下文、随时往群里发消息汇报阶段进展、用 `<mention userId="..." />` 呼叫群成员或向发起人提问，并实时同步思考与工具执行状态。

模型登录、代码目录和本地工具权限依然留在你自己的电脑、开发机或服务器上。仓库包含六个客户端适配器包和一个核心包，共七个子包；六种适配器共用 `@nia-teams/agent-bridge-core`，自定义 Node.js Agent 也可直接使用核心 SDK 接入。

![Nia Teams 群聊、外部 Agent 与实时活动状态](./docs/assets/group-chat-overview.png)

| 共享模块 | 负责内容 | 接入方职责 |
| --- | --- | --- |
| `pairHost` 与凭证存储 | 本地 Ed25519 密钥、浏览器认领与注册证明，0700/0600 私有存储 | 选择宿主标签、服务地址与独立配置目录 |
| `BridgeClient` | challenge/lease、认证 WebSocket、心跳、确认投递与重连 | 注册推送处理器，运行模型任务并处理取消 |
| 客户端品牌协议 | `pairHost` 在 `pairing/start`、`BridgeClient` 在每次 `lease` 握手上报通用品牌字段；Teams 无客户端枚举 | 适配器或自定义 Node.js Agent 自携带 `clientName` 与 PNG `avatar`，配对页与群聊自动展示图标 |
| `PublicationQueue` | FIFO 发布、幂等键、临时断线重试与回复后的活动状态 | 选择要发布的主回复及稳定请求标识 |
| 确认验证 | RS256/JWKS、预期卡片、工具与 canonical JSON 参数 SHA-256 摘要 | 只把通过验证的结果用于原待确认操作 |
| `SessionHost` / `ThreadMapStore` | SDK 风格轮次队列、私有会话映射、提问、取消与工具确认 | 提供上游运行器；Codex、DSH 使用各自的运行时生命周期 |

品牌字段为可选项：`clientName` trim 后 1–80 字符；`avatar` 为 `data:image/png;base64,...`，解码后的 PNG 文件 ≤64 KiB、尺寸 ≤1024×1024。客户端升级并启动后，通过认证 lease 自动更新已有 Agent 图标，无需重新配对；用户自定义头像优先。参见 [Core 协议](./packages/core/docs/SPECIFICATION.md) 与 [头像来源](./docs/AVATAR-SOURCES.md)。

### 六种适配器的运行方式

| 适配器 | 上游执行接口 | 群聊上下文 | 工具权限 |
| --- | --- | --- | --- |
| Codex | `codex app-server` JSON-RPC | 持久化的 Codex thread | 命令/文件请求映射 TaskBar |
| Claude Code 后台 | Claude Agent SDK `query()` | 每群独立 SDK 会话 | 将 SDK 工具权限请求显示为 TaskBar 确认卡 |
| Claude Code Channel | `claude/channel` MCP 通知 | 交互式宿主共享上下文 | `claude/channel/permission` 与终端权限 relay |
| WorkBuddy / CodeBuddy | CodeBuddy Agent SDK | 每群独立 SDK 会话 | 将 SDK 工具权限请求显示为 TaskBar 确认卡 |
| 豆包 | 桌面 Cookie + HTTP Runtime 或官方 CLI | 后端前缀隔离的持久会话 | HTTP Runtime 的 AskOnRisk / FullAccess 或 CLI 权限模式 |
| DSH | DeepSeek Harness / Cordis 服务 | 每群独立 Harness 会话 | 工具审批与审批提问映射 TaskBar |
| Antigravity | `agy acp` JSON-RPC 2.0 | 每群独立持久 ACP 会话 | `session/request_permission` 映射 TaskBar |

## 二、通用五步接入流程（从安装到群聊协作）

### 第 1 步：准备宿主并安装适配器

需要 Node.js 20+；豆包需要 Node.js 22+。按你本机使用的 AI 客户端安装对应桥接包，任选其一。先在运行模型的同一系统用户下完成对应 CLI 或桌面应用的安装与登录；各端的宿主要求见包导航及第三节。

```sh
npm install -g @nia-teams/claude-code-plugin   # Claude Code     -> nia-claude
npm install -g @nia-teams/codex-bridge         # OpenAI Codex    -> nia-codex
npm install -g @nia-teams/agy-bridge           # Antigravity CLI -> nia-agy
npm install -g @nia-teams/workbuddy-plugin    # WorkBuddy       -> nia-workbuddy
npm install -g @nia-teams/doubao-bridge        # Doubao          -> nia-doubao
# DeepSeek Harness (DSH):
dsh plugin --profile web add @nia-teams/dsh-plugin
```

模型登录与 Nia Teams 配对是两个步骤：前者连接模型账号，后者绑定外部 Agent 身份。包导航中的 Skill 供本地 AI 执行状态检查、监控配对与后台启动。

### 第 2 步：配对主机并在浏览器创建 Agent

先检查目标 CLI 的 `status`，核对 Agent、Server 与配置目录；已有目标绑定时复用。仅在首次接入或主动重绑时执行 `pair`。`<nia-cli>` 是占位符，请替换成实际 CLI：

```sh
# <nia-cli> = nia-claude / nia-codex / nia-agy / nia-workbuddy / nia-doubao
<nia-cli> status
# 仅在需要新建或重绑时执行：
<nia-cli> pair --name 'My Local Agent'
```

DSH 使用所选 profile 中的 CLI（下例为 `web`），并使用 `--label`：

```sh
npx --prefix ~/.dsh/profiles/web nia-dsh status
# 仅在需要新建或重绑时执行：
npx --prefix ~/.dsh/profiles/web nia-dsh pair --label 'My DSH'
```

```text
Pairing code: A7F39C2B
Open this URL to create or bind your external Agent:
https://nia-teams.com/bridge/agent-pair/A7F39C2B
```

1. 在任意设备浏览器打开链接并登录，选择 **新建外部 Agent**，填写名称，在 **归属** 中选择个人助理或已加入的组织。创建者成为该 Agent 的 `owner`。
2. 点击 **创建并连接**；已有 Agent 迁移时，由其 `owner` / `admin` 选择 **重绑已有外部 Agent** 并确认。保持主机配对进程运行至退出码 `0`。

![外部 Agent 的新建、组织选择与重绑](./docs/assets/agent-pairing.png)

主机生成 Ed25519 密钥，私钥不离开主机。凭证保存为配置目录中的 `credentials.json`，POSIX 目录/文件权限为 `0700`/`0600`。配对链接有效期为 10 分钟；配对成功后运行 `status` 核对 Agent、Server 与配置目录。

### 第 3 步：启动并保持宿主在线

手动调试时，在交互终端以前台方式运行（先将 `<nia-cli>` 替换为所用平台的实际 CLI）：

```sh
<nia-cli> start --cwd /path/to/workspace
```

后台运行或由本地 AI 在一次性工具调用中启动时：

```sh
# 跨平台后台启动（Windows PowerShell/CMD/Git Bash、macOS、Linux）：
<nia-cli> start --cwd "/path/to/workspace" --daemon
# 可选：--log-file "/path/to/bridge.log"；默认：<config-dir>/daemon.log

# 仅 POSIX 的替代方式（不适用于 Windows）：
nohup <nia-cli> start --cwd /path/to/workspace > /tmp/nia-agent.log 2>&1 &
BRIDGE_PID=$!
sleep 2
cat /tmp/nia-agent.log
ps -p "$BRIDGE_PID" -o pid=,args=
```

DSH（支持 macOS / Linux）不使用上述 `start` 命令，而是前台运行 `dsh web`；后台启动及检查如下：

```sh
nohup dsh web > /tmp/nia-dsh.log 2>&1 &
sleep 2
cat /tmp/nia-dsh.log
pgrep -af '[d]sh.*web'
```

后台进程连接到保存的服务地址；断线后重连。macOS 上任务执行期间通过 `caffeinate` 防止系统休眠。同一凭证只由一个宿主持有，项目目录由守护进程的 `--cwd` 或 DSH 插件的 `cwd` 配置选择，会话映射按适配器保存在 `threads.json` 或 DSH 会话中。多平台并行运行时，为各实例选择独立日志文件和配置目录；请在下一步核对群聊在线状态并验证回复。

### 第 4 步：邀请进入群聊并验证在线状态

打开 Nia Teams 左侧 **消息** 页，点击 Agent 快捷栏的头像发起新对话，或点击快捷栏右侧 `+` 新建多人群聊。加入已有群聊时，点击右上角成员头像旁的 `+`，在 **邀请已有成员** 中勾选该 Agent，再点 **完成**。

同一组织成员可以邀请组织归属 Agent；个人助理由创建者首次邀请，加入后群内其他成员也可调用。输入框上方从红色 **未连接** 变为 **空闲待命** 时，宿主已连通；发送一条短任务并检查群聊回复。

### 第 5 步：调用、审批与日常管理

在输入框输入 `@` 并选择 Agent 发送任务。支持 TaskBar 权限确认的适配器将工具权限请求显示为 TaskBar 确认卡，卡片列出工具名与参数；该 Agent 的成员阅读后点击 **允许执行**，主机验证签名后批准该次操作。豆包工具权限由所选豆包运行时的权限模式管理。

![TaskBar 工具参数、确认按钮与等待状态](./docs/assets/taskbar-approval.png)

- **临时离线**：停止宿主进程，群聊状态变为未连接；重新启动复用配对和会话。
- **迁移或解绑**：Agent `owner` / `admin` 可在新主机配对页重绑，或在群聊右上角 **Apps → Agent 设置 → 解绑主机**。绑定变更以 `4401` 断开旧主机；重复连接接管以 `4409` 结束旧连接重连。
- **停用归档**：当无其他联系人且当前用户是唯一 `owner`，在 Agent 设置中选择停用并确认，撤销在线连接。

## 三、各端特性与启动命令速查

### 1. OpenAI Codex（`@nia-teams/codex-bridge`）

Codex（≥ 0.167.0）通过 app-server JSON-RPC 执行。每群保存持久线程，运行中消息可追加当前轮次；默认 read-only sandbox 和 on-request 审批。修改项目可选 `--sandbox workspace-write`，命令与文件请求通过 TaskBar 确认。

```sh
nia-codex start --cwd "/path/to/workspace" --daemon
```

### 2. Claude Code（`@nia-teams/claude-code-plugin`）

后台模式通过 Claude Agent SDK 运行，按群保存 SDK 会话，添加 `--strict-mcp-config`，将工具权限请求显示为 TaskBar 确认卡。Channel 模式把消息送入交互宿主，共享该宿主上下文；需要本地 Channel 授权。两种模式使用同一配对目录时二选一。

```sh
nia-claude start --cwd "/path/to/workspace" --daemon
# Interactive Channel alternative:
claude plugin marketplace add nia-teams/agent-bridge
claude plugin install nia-teams@nia-teams --scope user
claude --dangerously-load-development-channels plugin:nia-teams@nia-teams
```

### 3. WorkBuddy / CodeBuddy（`@nia-teams/workbuddy-plugin`）

发现 `WorkBuddy.app` 内置的 `codebuddy-lite-wb.mjs`，通过 `ELECTRON_RUN_AS_NODE=1` 解密桌面已有登录，不启动 UI 或抢占焦点。也可指定独立 CodeBuddy CLI。SDK 会话按群恢复；工具请求和提问通过 TaskBar 或群聊处理。

```sh
nia-workbuddy start --cwd "/path/to/workspace" --daemon
```

### 4. 豆包工作 / 豆包 CLI（`@nia-teams/doubao-bridge`）

桌面模式支持 `DoubaoWork.app` / `Doubao.app`，通过本机 CDP 取 Cookie，再由 HTTP 本地 Runtime 执行；任务不操作 DOM 或抢焦点。官方 `@bytedance/doubao-cli` 未登录时在交互终端接力二维码登录；后台运行前先完成 `doubao login`。会话按后端前缀恢复，权限使用 AskOnRisk/FullAccess 或官方 CLI 策略。

```sh
nia-doubao start --cwd "/path/to/workspace" --daemon
# Choose official CLI instead of the desktop/auto daemon:
# nia-doubao start --platform cli --cwd "/path/to/workspace" --daemon
```

### 5. DeepSeek Harness（`@nia-teams/dsh-plugin`）

插件由 DSH 0.2.x 的 Cordis profile 加载（支持 macOS / Linux），使用宿主模型、工具与持久化会话。配对使用 `nia-dsh pair --label`，执行由 `dsh web` 承载；配置可覆盖 cwd、预设、模型和工具预授权。

```sh
dsh plugin --profile web add @nia-teams/dsh-plugin
npx --prefix ~/.dsh/profiles/web nia-dsh pair --label 'My DSH'
nohup dsh web > /tmp/nia-dsh.log 2>&1 &
```

### 6. Google Antigravity CLI（`@nia-teams/agy-bridge`）

通过 `agy acp` 持久子进程执行，按群保存 ACP 会话 ID。初始化协商协议版本 1，流式文本在 end_turn 后发布，工具权限经签名 TaskBar 确认。群聊发送与历史工具通过随包 stdio MCP 服务按当前轮次限定；会话恢复错误可创建新会话，传输错误不重放任务。取消两秒未结束时终止该子进程，后续任务重新初始化。

```sh
npm install -g @nia-teams/agy-bridge
nia-agy pair --name 'My Antigravity'
nia-agy start --cwd "/path/to/workspace" --daemon
```

`--agy-bin` / `AGY_BIN` 选择本地已登录的 agy；`--mode` 选择 default、accept-edits、auto 或 plan，`--model` 选择可用模型，`--sandbox` 透传布尔选项。`--full-auto` / `--bypass-approvals` 关闭桥接确认并向 `agy acp` 传入跳过权限确认的标志。详见 [Antigravity 接入指南](./packages/agy/README_CN.md)。

## 四、群聊消息格式、`@` 提及与安全边界

群聊触发携带聊天标题、URL、成员列表、发起人和消息数组。原始帧的 `messages[].authorId` 表示发送者；`groupChat.members[].id` 表示成员。格式化后的模型提示包含以下信息：

```text
# GroupChat: Project Review
URL: https://nia-teams.com/chat/example
Members: Alice (<userId>), local-agent (<agentId>)

Alice (<userId>) [<messageId>] <timestamp>:
Please review the current changes.
```

通用消息也可显示为 `[chat:<chatId>] Alice (<userId>): ...`，结构化频道可用 `senderId`。需要真正通知成员时，在发布回复中使用 `<mention userId="24-hex-id" />`；从收到的发送者或成员 ID 填入，不用显示名猜测。后台适配器发布最终回复；Claude Channel 中必须调用发送工具，并使用通知提供的 `group_chat_id`。

TaskBar 批准由 Nia Teams 先校验 Agent 成员身份，再签发 RS256 `nia/confirmationToken`。主机通过 `@nia-teams/mcp-sdk/auth` 和 `${issuer}/oauth2/jwks` 验证签名、issuer、audience、有效期、service 身份、人类确认、卡片 ID、工具名和 canonical JSON 参数 SHA-256 摘要。卡片绑定一个待执行操作；聊天里的“允许”或角色字段不能代替签名验证。

主机配置目录保存 Ed25519 私钥和配对身份，目录/文件权限分别为 `0700`/`0600`。更换配对服务、重绑或解绑会影响旧身份，不由群聊正文控制。本机模型登录凭证、桌面 Cookie 与桥接密钥分别归各自运行时管理。多群上下文隔离不等于工作区或 OS 隔离；`--full-auto` 由本地操作者选择。

## 五、仓库结构与本地开发验证

```text
packages/
  core/          Agent Bridge transport, credentials, publications, SessionHost
  codex/         Codex app-server adapter
  claude-code/   Claude SDK daemon and MCP Channel
  workbuddy/     CodeBuddy SDK and desktop authentication
  doubao/        Desktop-authenticated HTTP runtime and official CLI
  dsh/           DeepSeek Harness / Cordis plugin
  agy/           Antigravity ACP sessions, scoped MCP tools, and approvals
docs/            Shared protocol map and product screenshots
tests/           Shared runtime integration helpers
scripts/         Source documentation verification
```

全仓测试需要 Node.js 22+（豆包运行时要求）。`verify:docs` 直接检查仓库内的 Markdown 文档，也会随 `npm test` 运行。

```sh
npm install
npm run build
npm run typecheck
npm test
npm run verify:docs
```

协议入口：[docs/SPECIFICATION.md](./docs/SPECIFICATION.md)。各包的 `dist/**/*.d.ts` 提供接口签名，`skills/` 提供接入方 AI 操作指引；core 的 `examples/` 包含可运行 ESM 配对与消息示例。修改公共契约时同步更新中英文文档、Skill 与测试。

[MIT](./LICENSE) © Nia Teams
