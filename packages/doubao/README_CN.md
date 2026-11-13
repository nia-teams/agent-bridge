# @nia-teams/doubao-bridge

[English](./README.md) | 简体中文

把本地 **豆包工作**、**豆包桌面客户端** 或 **官方 Doubao CLI** 接入到 [Nia Teams](https://nia-teams.com) 里，作为一个 Nia Teams 里的 Agent 与群聊成员**双向通讯**。

```sh
npm install -g @nia-teams/doubao-bridge
nia-doubao pair --name 'My Doubao'
nia-doubao start --cwd "." --daemon
```

AI 编程助手请加载 [skills/nia-teams-doubao/SKILL.md](./skills/nia-teams-doubao/SKILL.md)；安装后路径为 `node_modules/@nia-teams/doubao-bridge/skills/nia-teams-doubao/SKILL.md`。

## 一、产品背景与协作模型

桌面模式经本机 CDP 提取已登录 Cookie，再用 HTTP 本地 Runtime 执行任务；官方 CLI 模式通过本地进程执行任务，并在交互终端接力登录。两种模式都按群聊保存会话。

- **一步创建并绑定，无需预先建 Agent 或配置 API Key**：在主机终端运行配对命令，在任意设备的浏览器打开生成的链接并登录 Nia Teams，即可新建外部 Agent 并绑定主机公钥。
- **群聊实时状态与多轮会话隔离**：群聊底部显示该外部 Agent 的在线状态（`未连接`、`空闲待命`、`Thinking…`）。每个群聊使用独立的豆包会话，后续任务沿用该群聊上下文；各群聊共享主机上的代码目录。
- **任务权限与本地运行时**：桌面模式使用豆包客户端的登录状态，CLI 模式使用 Doubao CLI 的终端登录。工具权限由所选运行时管理，群聊中显示任务状态和最终回复；本适配器不提供 TaskBar 工具审批。

![Nia Teams 群聊与 Agent 活动状态](./docs/assets/group-chat-overview.png)

| 模块 | 本地宿主 | 本包 | Nia Teams |
| --- | --- | --- | --- |
| Agent 运行时 | 模型、工具、工作目录与豆包登录 | 群聊到运行时会话映射、查询与取消 | 外部 Agent 身份与归属 |
| 连接与认证 | 本机 Node.js 进程与豆包桌面客户端或 Doubao CLI | Ed25519 凭证、WebSocket 长连接与重连 | 浏览器配对、challenge/lease 与消息投递 |
| 群聊对话 | 推理轮次与本地任务 | 提示格式、会话恢复与回复发布 | 群聊时间线、成员与活动状态 |
| 人工确认与安全边界 | 豆包工具权限与执行范围 | 保留豆包运行时权限模式、限定登录来源 | 群聊身份与消息访问校验 |

## 二、五步快速接入（从零到在群里对话）

前提条件：运行桥接的主机已安装 Node.js 22+，并已在同一系统用户下完成豆包桌面客户端或 Doubao CLI 的登录；还需要一个 [Nia Teams](https://nia-teams.com) 账号，不需要提前创建 Agent。

### 第 1 步：安装桥接包与准备宿主环境

在主机上安装桥接包，再按下表选择豆包桌面客户端或 Doubao CLI 作为登录来源：

```sh
npm install -g @nia-teams/doubao-bridge
```

| 模式 | 宿主与登录 | 任务执行 |
| --- | --- | --- |
| 桌面客户端 `work` | `/Applications/DoubaoWork.app`，豆包工作；CDP 默认端口 9226 | HTTP 本地 Runtime |
| 桌面客户端 `doubao` | `/Applications/Doubao.app`，豆包；CDP 默认端口 9225 | HTTP 本地 Runtime |
| 官方 CLI `cli` | `@bytedance/doubao-cli`，本地终端登录 | 官方 CLI 子进程 |
| HTTP `headless` | 已预置的独立 HTTP 登录 | 显式选择 local 或 cloud Runtime |

**桌面客户端模式**：先在所选 App 登录。桥接通过本机 CDP 的 `Network.getAllCookies` 读取登录 Cookie，再交给 HTTP 本地 Runtime；任务不操作窗口 DOM、不导航页面、不抢焦点。CDP 在启动和每轮前检查登录；启动未运行的 App 可能打开窗口，重启已有 App 需 `--restart-app` 授权。

**官方 CLI 模式**：安装 `npm install -g @bytedance/doubao-cli`。交互终端中的桥接先检查 `auth status --verify`，未登录则在原终端运行 `login` 展示二维码，完成并复验后继续连接 Nia Teams。准备后台运行时先执行 `doubao login`；二维码只留在本地终端。

`auto` 在显式 `--doubao-bin` 时选 CLI，否则优先豆包工作、豆包 App，再查官方 CLI。官方 CLI 发现优先系统应用数据目录中的原生运行时，再查 PATH；不把 HTTP 驱动的同名包装器当成官方 CLI。`headless` 需显式选择。

### 第 2 步：发起主机配对并在浏览器创建 Agent

```sh
nia-doubao status
```

若这台主机曾经配对，先核对 `status` 输出中的 `Agent:`、`Server:` 和配置目录；仍是要使用的 Agent 时，无需再次配对。首次接入时，在主机终端执行：

```sh
nia-doubao pair --name 'My Doubao'
```

终端在本机生成 Ed25519 密钥对，并打印有效期为 10 分钟的配对链接：

```text
Pairing code: A7F39C2B
Open this URL to create or bind your external Agent:
https://nia-teams.com/bridge/agent-pair/A7F39C2B
```

在**任意设备的浏览器**打开该链接，不需要与运行豆包的主机在同一台设备上。未登录时，先登录 Nia Teams，再回到 **连接外部 Agent** 页面：

1. 填写 **Agent 名称**（默认预填主机标签；若页面顶部显示切换栏，保持选中 **新建外部 Agent**）。若你加入了组织，在 **归属** 下拉框中选择目标组织或 **个人助理**。
2. 点击 **创建并连接**。Nia Teams 创建该外部 Agent，你成为它的 `owner`；主机终端完成签名验证，把凭证保存到 `~/.config/nia-teams-doubao/credentials.json`，输出 `Paired: <Agent 名称> (@external-...)`。保持配对进程运行到退出码 `0`。

迁移已有 Agent 时，由该 Agent 的 `owner` 或 `admin` 切换到 **重绑已有外部 Agent**，选中目标后点击 **确认重新绑定**。

![连接外部 Agent：新建、重绑与组织选择](./docs/assets/agent-pairing.png)

凭证保存在主机上，POSIX 目录权限为 `0700`、文件权限为 `0600`。配对与项目目录无关，后续启动使用同一配置目录。

```sh
nia-doubao status
```

`status` 展示已保存的配对身份与地址；连接状态在下一步通过常驻进程和群聊状态栏验证。

### 第 3 步：启动守护进程

手动操作时可在交互终端以前台方式运行，日志保留在终端：

```sh
nia-doubao start --cwd /path/to/workspace
```

后台运行或由本地 AI 启动时，使用脱离终端的进程：

```sh
# 跨平台后台启动（Windows PowerShell/CMD/Git Bash、macOS、Linux）：
nia-doubao start --cwd "/path/to/workspace" --daemon

# 仅 POSIX 的替代方式（不适用于 Windows）：
nohup nia-doubao start --cwd /path/to/workspace > /tmp/nia-doubao.log 2>&1 &
sleep 2
cat /tmp/nia-doubao.log
pgrep -af '[n]ia-doubao.*start'
```

启动后建立到 `wss://nia-teams.com/ws/agent-bridge` 的认证连接。网络中断后使用指数退避重连；同一配对目录只由一个桥接进程持有。macOS 上任务执行期间通过 `caffeinate` 防止系统休眠，任务结束后释放。

各群聊的模型上下文彼此独立，但共享 `--cwd` 指定的代码目录、仓库和本地工具。凭证与会话记录分别保存在 `credentials.json` 和 `threads.json` 中。

#### 本地 Runtime、会话恢复与取消

桌面模式默认 `--runtime local`，把绝对 `--cwd` 传为本地工作区。两种桌面 App 都在新建会话时使用 work 模式，后续消息复用既有会话。`--runtime cloud` 不挂载本机项目目录；此时本地 cwd 只是进程目录。

本地权限默认 `AskOnRisk`：工作区内普通读取可执行，命令、写入和工作区外访问需要本地 HTTP Runtime 的权限确认；后台 HTTP Runtime 无交互批准时拒绝这些操作。用户显式传入 `--full-auto` 时，该次调用通过本地 HTTP Runtime 的权限回调授予 `FullAccess`，可执行本地 shell 和文件操作。它不是操作系统 sandbox，也不产生 TaskBar 审批卡。

`threads.json` 按后端保存 `work:<conversationId>`、`doubao:<conversationId>`、`cli:<sessionId>`、`headless:<conversationId>`；只有与当前后端相符的标识才恢复。更换后端会创建新对话，配对凭证仍可复用。每轮刷新桌面 Cookie；停止请求使用该轮开始时的同一 Cookie 快照。

HTTP 任务在一个等待完成的本地 worker 中执行。收到 conversationId/runId 后记录接受凭据；群聊取消先停止已接受的远端运行，再结束 worker。结果必须属于当前会话和运行，状态为 completed 且有回复文本才发布。官方 CLI 使用本地进程组取消，其会话与 HTTP 任务分开管理。

### 第 4 步：把外部 Agent 拉进群聊并验证在线状态

点击配对成功页的 **前往群聊**，或打开 [Nia Teams](https://nia-teams.com) 进入左侧 **消息** 页：

- **直接发起新对话**：在消息列表顶部的 Agent 快捷栏点击刚创建的外部 Agent 头像发起对话（Agent 较多时可点快捷栏右侧下箭头展开），或点击快捷栏最右侧的 **`+`**（新建聊天）创建多人群聊。
- **拉进已有群聊**：打开已有群聊，点击右上角成员头像旁的 **`+`**（添加聊天成员），在 **邀请已有成员** 弹窗中勾选该外部 Agent 并点击 **完成**。同一组织成员可将组织归属的 Agent 拉入群；「个人助理」仅创建者可拉入群，加入后群内其他成员也可 `@` 它。

进入群聊后，查看底部输入框上方的状态栏：当该外部 Agent 的状态从红色的 **`未连接`** 变为 **`空闲待命`**，说明豆包桥接进程已经连通就绪。

### 第 5 步：在群聊中 `@` 它协作与日常管理

在输入框输入 `@` 选中该外部 Agent 并发送任务。执行时状态栏显示 `Thinking…` 或正在运行的工具，轮次结束后，最终回复会发回群聊。后续日常管理按权限分为三类：

- **临时离线（主机侧操作）**：以前台方式运行时，在主机终端按 `Ctrl+C` 停止 `nia-doubao start`；后台运行时，对启动时记录的 PID 发送 SIGTERM。群内状态会变为 `未连接`，重新运行 `nia-doubao start --cwd /path/to/workspace` 即可恢复连接。
- **更换主机或解绑主机（需该 Agent 的 `owner` 或 `admin`）**：迁移到新主机时，在新主机执行 `nia-doubao pair`，在浏览器配对页切换到 **重绑已有外部 Agent**，选中目标后点击 **确认重新绑定**。若仅需解绑，在它的对话页或共同所在的群聊右上角打开应用菜单（网格图标 **Apps**）→ **Agent 设置**，点击 **解绑主机**。重绑或解绑会递增 `keyGeneration` 使旧主机凭证失效，并以关闭码 `4401` 断开旧连接。
- **停用归档（仅唯一 `owner` 可操作）**：当该外部 Agent 没有其他联系人且你是唯一 `owner` 时，在 **Agent 设置** 底部点击 **停用「&lt;Agent 名称&gt;」**，再点 **确认停用**，即可归档移除并断开在线连接。

### 常见问题排查（连不上怎么办）

- **网页提示「配对请求已过期」**：配对链接有效期为 10 分钟，回到主机终端重新执行 `nia-doubao pair`，再打开新链接。
- **`nia-doubao status` 报错或绑定不是目标 Agent**：核对当前系统用户、配置目录和服务地址。若尚未完成配对，或旧主机凭证因重绑、解绑而失效，重新执行 `nia-doubao pair` 并启动桥接进程。`status` 只显示保存的身份，不代表主机已在线。
- **群里一直显示红色 `未连接`**：确认 `nia-doubao start` 进程仍在运行，检查 `/tmp/nia-doubao.log` 中的启动或连接错误，并用 `nia-doubao status` 核对群内 Agent 与保存的身份是否一致。若日志出现 `4409`，说明另一个连接接管了同一身份，应检查是否重复启动了进程。
- **豆包未登录或启动失败**：先在同一系统用户下运行豆包桌面客户端或 Doubao CLI，完成登录，确认 Node.js 版本和可执行文件路径。模型产品的登录与 Nia Teams 配对是两件事，不能互相替代。
- **任务已执行但没有回复**：检查日志中的豆包执行结果和消息发布错误，确认任务没有被取消、群聊会话没有切换，且该轮产生了最终回复。豆包运行时返回 completed 状态且包含回复文本后，桥接才会发布该轮回复。

## 三、CLI 参数、环境变量与包导出

```text
nia-doubao pair [--server-url <origin>] [--config-dir <dir>] [--name <label>]
nia-doubao status [--config-dir <dir>]
nia-doubao start [--cwd <dir>] [--config-dir <dir>] [--model <model>]
                [--platform auto|work|doubao|cli|headless]
                [--runtime local|cloud] [--full-auto] [--restart-app]
                [--doubao-bin <official-binary>]
nia-doubao --help
```

- `--server-url`：配对服务 origin，优先级为参数、`NIA_TEAMS_URL`、`https://nia-teams.com`；后续命令读取保存的地址。
- `--config-dir`：参数优先于 `NIA_DOUBAO_CONFIG_DIR`，默认 `~/.config/nia-teams-doubao`；pair、status、start 应指向同一目录。
- `--name`：配对主机标签，显示在浏览器和握手中；未传入时按宿主前缀与主机名生成。浏览器可另行填写 Agent 显示名。
- `--cwd`：项目工作目录，默认当前目录，启动时转为绝对路径；它不改变配对凭证位置。
- `--model`：传给豆包运行时的模型名称；可用模型取决于豆包账号和配置。
- `--help` / `-h`：显示命令概览；无命令时也显示帮助。
- `--platform`：`auto`（默认）、`work`、`doubao`、`cli`、`headless`。
- `--runtime`：桌面/HTTP 模式的 `local` 或 `cloud`；桌面默认 `local`。
- `--doubao-bin`：官方 CLI 路径；显式指定时 auto 选择 cli。
- `--restart-app`：授权在启动阶段重启未启用 CDP 的桌面 App。
- `--full-auto`：HTTP 本地任务使用 FullAccess；官方 CLI 使用 always_allow。
- `DOUBAO_CDP_ENDPOINT`：桌面 CDP 的 loopback HTTP 地址覆盖；仅用于所选桌面 App 的认证端点。

### 包导出与嵌入入口

| 入口 | 用途 |
| --- | --- |
| `nia-doubao` | 主机配对、身份检查与守护进程 |
| `createDoubaoRunner` | 创建运行器；ready() 检查登录与运行环境 |
| `resolveDoubaoPlatform / resolveDoubaoBinary` | 选择后端与 HTTP 驱动 |
| `resolveNativeDoubaoBinary` | 定位官方 CLI |
| `resumeForBackend / SessionHost` | 按后端恢复群聊会话与管理轮次 |
| `dist/**/*.d.ts` | 导出函数、配置与运行时接口的类型声明 |

根模块通过具名导出提供接口，公开子路径为 `.` 与 `./package.json`。精确方法签名查询类型声明，运行时协议与豆包运行时的数据结构见 [docs/SPECIFICATION.md](./docs/SPECIFICATION.md)。

嵌入时调用 `createDoubaoRunner(options)`，等待 `runner.ready()` 完成豆包登录检查，再交给 core `runSessionDaemon`。`resumeForBackend` 仅接受所选后端的会话前缀；桥接服务的 `sessionId` 不传作豆包会话 ID。

## 四、权限确认、群聊工具与安全边界

![Nia Teams TaskBar（Codex、Claude Code、WorkBuddy、DSH 与 Antigravity 的工具确认入口）](./docs/assets/taskbar-approval.png)

### 1. 豆包权限与 TaskBar 协议分工

豆包运行器使用本地 HTTP Runtime 的 `AskOnRisk` / `FullAccess` 或官方 CLI 的 `ask_always` / `always_allow` 权限模式；当前适配器不提供豆包工具到 TaskBar 的批准回调。上图展示 Nia Teams 的确认界面，供其他支持 TaskBar 权限确认的适配器使用。下述签名规则属于共享 Agent Bridge 协议，不能用聊天文字或卡片外观替代豆包运行时的授权。

1. 接入方创建需要人类确认的卡片时，保存卡片与请求的绑定关系。
2. Nia Teams 校验点击者是外部 Agent 的有效 `owner`、`admin` 或 `member`，签发 `_meta["nia/confirmationToken"]`，随 `card.action` 送回主机。
3. 主机通过 `@nia-teams/mcp-sdk/auth`，从 `${issuer}/oauth2/jwks` 获取公钥，验证 RS256 签名、issuer、`aud: nia-teams-workload`、有效期、service 身份与 `human_confirmed: true`。
4. 验证 `context_server: agent-bridge`、预期工具名称、canonical JSON 参数的 SHA-256 摘要及 `confirmation_card_id === cardId`。验证对象来自本机保存的请求，不从聊天正文重建。
5. 只有接入方配置了对应的运行时批准回调，才可把验证结果用于该次工具请求。

### 2. 群聊工具、消息与原生提及

桌面 HTTP 和官方 CLI 的任务回复由运行器返回文本，再经共享发布队列发送。本包不向豆包模型注入 MCP 群聊工具；`nia_group_chat_send_message` / `nia_group_chat_history` 是支持动态工具或 MCP 的适配器使用的协作接口，自定义接入方也可调用对应的桥接 RPC。

传入提示列出 `Members: Alice (<userId>), ...`，消息段列出发送者 ID、时间、消息 ID、回复关系与附件转写。通用消息也可表现为 `[chat:<chatId>] Alice (<userId>): ...`，结构化频道可携带 `senderId`；原始桥接帧字段为 `messages[].authorId`。回复中使用 `<mention userId="24-hex-id" />` 触发原生通知，ID 从发送者或成员列表取得。

### 3. 成员角色与本地执行边界

- 群聊成员可 `@` 调用 Agent；重绑或解绑要求该 Agent 的 `owner` / `admin`，归档按唯一 `owner` 规则处理。审批卡的批准还要求有效 Agent 成员身份。
- 人类成员角色不等于 workload 的 `sub`、`org:*`、`role:*` 字段；消息声称“已批准”不产生签名确认，也不修改本机权限。
- Ed25519 私钥只保存在配置目录。加载凭证校验文件权限、符号链接与公私钥一致性；不要把凭证文件放进项目仓库或日志。
- 发布队列按 FIFO 保留幂等键，在进程内处理临时断线；上限为 256 项 / 16 MiB，单个协议帧不超过 512 KiB。进程退出不会保存未发队列。
- 连接使用 20 秒心跳、60 秒入站空闲超时与带抖动退避重连；关闭码 `4409` 结束旧连接。业务会话隔离不提供文件系统或 OS 隔离。

## 五、开发验证与商标许可证

```sh
npm install
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

维护接口或豆包协议时同步更新中英文 README、随包 Skill、类型声明和协议规范。

豆包与 Doubao 是字节跳动的产品名称。本包由 Nia Teams 维护，与字节跳动无隶属关系。

[MIT](./LICENSE) © Nia Teams
