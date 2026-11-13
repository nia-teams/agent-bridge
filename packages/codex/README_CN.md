# @nia-teams/codex-bridge

[English](./README.md) | 简体中文

把本地或服务器上的 **OpenAI Codex** 接入到 [Nia Teams](https://nia-teams.com) 里，作为一个 Nia Teams 里的 Agent 与群聊成员**双向通讯**。

```sh
npm install -g @nia-teams/codex-bridge
nia-codex pair --name 'My OpenAI Codex'
nia-codex start --cwd "." --daemon
```

AI 编程助手请加载 [skills/nia-teams-codex/SKILL.md](./skills/nia-teams-codex/SKILL.md)；安装后路径为 `node_modules/@nia-teams/codex-bridge/skills/nia-teams-codex/SKILL.md`。

## 一、产品背景与协作模型

桥接进程通过 `codex app-server` JSON-RPC 驱动本机 Codex。每个群聊使用独立且持久化的线程；团队在群聊中发起任务、查看执行状态并批准命令或文件改动。

- **一步创建并绑定，无需预先建 Agent 或配置 API Key**：在主机终端运行配对命令，在任意设备的浏览器打开生成的链接并登录 Nia Teams，即可新建外部 Agent 并绑定主机公钥。
- **群聊实时状态与多轮会话隔离**：群聊底部显示该外部 Agent 的在线状态（`未连接`、`空闲待命`、`Thinking…`、`等待确认`）。每个群聊使用独立的 Codex 线程，后续任务沿用该群聊上下文；各群聊共享主机上的代码目录。
- **TaskBar 权限确认与群聊工具**：当 OpenAI Codex 请求工具权限时，群聊底部 TaskBar 会弹出权限确认卡，由该 Agent 的成员点击 **允许执行**。Agent 也可通过群聊工具发送进度、读取历史。

![Nia Teams 群聊与 Agent 活动状态](./docs/assets/group-chat-overview.png)

| 模块 | 本地宿主 | 本包 | Nia Teams |
| --- | --- | --- | --- |
| Agent 运行时 | 模型、工具、工作目录与 Codex 登录 | 群聊到运行时会话映射、查询与取消 | 外部 Agent 身份与归属 |
| 连接与认证 | 本机 Node.js 进程与 Codex CLI | Ed25519 凭证、WebSocket 长连接与重连 | 浏览器配对、challenge/lease 与消息投递 |
| 群聊对话 | 推理轮次与本地任务 | 提示格式、会话恢复与回复发布 | 群聊时间线、成员与活动状态 |
| 人工确认与安全边界 | Codex 工具权限与执行范围 | 将工具权限请求显示为 TaskBar 确认卡、RS256 验签与请求匹配 | TaskBar 卡片、Agent 成员权限与签名 |

## 二、五步快速接入（从零到在群里对话）

前提条件：运行桥接的主机已安装 Node.js 20+，并已在同一系统用户下完成 Codex CLI 的登录；还需要一个 [Nia Teams](https://nia-teams.com) 账号，不需要提前创建 Agent。

### 第 1 步：安装桥接包与准备宿主环境

在主机上安装下列 Codex CLI 版本，完成 Codex 登录后，再安装桥接包：

```sh
npm install -g @openai/codex@0.167.0
codex login
npm install -g @nia-teams/codex-bridge
```

`codex login` 管理 OpenAI 账号登录，`nia-codex pair` 管理 Nia Teams 的外部 Agent 身份。两套身份分别保存在各自配置中。运行桥接的系统用户应能执行 `codex --version` 并读取目标项目。

桥接启动一个 `codex app-server` 子进程，通过标准输入输出交换 JSONL JSON-RPC。无需给 Codex 配置额外的 MCP 服务；群聊发送和历史工具作为该线程的 dynamic tools 注册。使用其他安装位置时，用 `--codex-bin /absolute/path/to/codex` 指定。

### 第 2 步：发起主机配对并在浏览器创建 Agent

```sh
nia-codex status
```

若这台主机曾经配对，先核对 `status` 输出中的 `Agent:`、`Server:` 和配置目录；仍是要使用的 Agent 时，无需再次配对。首次接入时，在主机终端执行：

```sh
nia-codex pair --name 'My OpenAI Codex'
```

终端在本机生成 Ed25519 密钥对，并打印有效期为 10 分钟的配对链接：

```text
Pairing code: A7F39C2B
Open this URL to create or bind your external Agent:
https://nia-teams.com/bridge/agent-pair/A7F39C2B
```

在**任意设备的浏览器**打开该链接，不需要与运行 OpenAI Codex 的主机在同一台设备上。未登录时，先登录 Nia Teams，再回到 **连接外部 Agent** 页面：

1. 填写 **Agent 名称**（默认预填主机标签；若页面顶部显示切换栏，保持选中 **新建外部 Agent**）。若你加入了组织，在 **归属** 下拉框中选择目标组织或 **个人助理**。
2. 点击 **创建并连接**。Nia Teams 创建该外部 Agent，你成为它的 `owner`；主机终端完成签名验证，把凭证保存到 `~/.config/nia-teams-codex/credentials.json`，输出 `Paired: <Agent 名称> (@external-...)`。保持配对进程运行到退出码 `0`。

迁移已有 Agent 时，由该 Agent 的 `owner` 或 `admin` 切换到 **重绑已有外部 Agent**，选中目标后点击 **确认重新绑定**。

![连接外部 Agent：新建、重绑与组织选择](./docs/assets/agent-pairing.png)

凭证保存在主机上，POSIX 目录权限为 `0700`、文件权限为 `0600`。配对与项目目录无关，后续启动使用同一配置目录。

```sh
nia-codex status
```

`status` 展示已保存的配对身份与地址；连接状态在下一步通过常驻进程和群聊状态栏验证。

### 第 3 步：启动守护进程

手动操作时可在交互终端以前台方式运行，日志保留在终端：

```sh
nia-codex start --cwd /path/to/workspace
```

后台运行或由本地 AI 启动时，使用脱离终端的进程：

```sh
# 跨平台后台启动（Windows PowerShell/CMD/Git Bash、macOS、Linux）：
nia-codex start --cwd "/path/to/workspace" --daemon

# 仅 POSIX 的替代方式（不适用于 Windows）：
nohup nia-codex start --cwd /path/to/workspace > /tmp/nia-codex.log 2>&1 &
sleep 2
cat /tmp/nia-codex.log
pgrep -af '[n]ia-codex.*start'
```

启动后建立到 `wss://nia-teams.com/ws/agent-bridge` 的认证连接。网络中断后使用指数退避重连；同一配对目录只由一个桥接进程持有。macOS 上任务执行期间通过 `caffeinate` 防止系统休眠，任务结束后释放。

各群聊的模型上下文彼此独立，但共享 `--cwd` 指定的代码目录、仓库和本地工具。凭证与会话记录分别保存在 `credentials.json` 和 `threads.json` 中。

#### Codex 线程、轮次与消息到达

`threads.json` 记录 `agentThreadId → { codexThreadId, groupChatId, updatedAt }`。群聊的下一轮先恢复已保存线程；本机 Codex rollout 已删除时创建新线程并更新映射，Nia 配对身份不变。`groupChatId` 是群聊身份，`sessionId` 是当前群聊会话标识，不能替换为 Codex 的 thread ID。

同一群聊正在运行时，新消息优先通过 `turn/steer` 追加到当前轮次；Codex `app-server` 拒绝追加时排入后续轮次。群聊会话切换会中断旧轮次、拒绝旧卡片，并阻止旧结果发到新的群聊会话。群聊取消使用 `turn/interrupt`，同时清理排队输入与待确认请求。

Codex 的默认 sandbox 是 `read-only`，审批策略是 `on-request`。需要修改项目时可选择 `--sandbox workspace-write`，仍保留工具确认。`danger-full-access` 放开 Codex sandbox；`--full-auto` / `--bypass-approvals` 把审批策略设为 `never`，未指定 sandbox 时改用 `workspace-write`。这两个设置分别控制执行范围和审批，不能互相替代。

### 第 4 步：把外部 Agent 拉进群聊并验证在线状态

点击配对成功页的 **前往群聊**，或打开 [Nia Teams](https://nia-teams.com) 进入左侧 **消息** 页：

- **直接发起新对话**：在消息列表顶部的 Agent 快捷栏点击刚创建的外部 Agent 头像发起对话（Agent 较多时可点快捷栏右侧下箭头展开），或点击快捷栏最右侧的 **`+`**（新建聊天）创建多人群聊。
- **拉进已有群聊**：打开已有群聊，点击右上角成员头像旁的 **`+`**（添加聊天成员），在 **邀请已有成员** 弹窗中勾选该外部 Agent 并点击 **完成**。同一组织成员可将组织归属的 Agent 拉入群；「个人助理」仅创建者可拉入群，加入后群内其他成员也可 `@` 它。

进入群聊后，查看底部输入框上方的状态栏：当该外部 Agent 的状态从红色的 **`未连接`** 变为 **`空闲待命`**，说明 OpenAI Codex 桥接进程已经连通就绪。

### 第 5 步：在群聊中 `@` 它协作与日常管理

在输入框输入 `@` 选中该外部 Agent 并发送任务。执行时状态栏显示 `Thinking…` 或正在运行的工具，轮次结束后，最终回复会发回群聊。后续日常管理按权限分为三类：

- **临时离线（主机侧操作）**：以前台方式运行时，在主机终端按 `Ctrl+C` 停止 `nia-codex start`；后台运行时，对启动时记录的 PID 发送 SIGTERM。群内状态会变为 `未连接`，重新运行 `nia-codex start --cwd /path/to/workspace` 即可恢复连接。
- **更换主机或解绑主机（需该 Agent 的 `owner` 或 `admin`）**：迁移到新主机时，在新主机执行 `nia-codex pair`，在浏览器配对页切换到 **重绑已有外部 Agent**，选中目标后点击 **确认重新绑定**。若仅需解绑，在它的对话页或共同所在的群聊右上角打开应用菜单（网格图标 **Apps**）→ **Agent 设置**，点击 **解绑主机**。重绑或解绑会递增 `keyGeneration` 使旧主机凭证失效，并以关闭码 `4401` 断开旧连接。
- **停用归档（仅唯一 `owner` 可操作）**：当该外部 Agent 没有其他联系人且你是唯一 `owner` 时，在 **Agent 设置** 底部点击 **停用「&lt;Agent 名称&gt;」**，再点 **确认停用**，即可归档移除并断开在线连接。

### 常见问题排查（连不上怎么办）

- **网页提示「配对请求已过期」**：配对链接有效期为 10 分钟，回到主机终端重新执行 `nia-codex pair`，再打开新链接。
- **`nia-codex status` 报错或绑定不是目标 Agent**：核对当前系统用户、配置目录和服务地址。若尚未完成配对，或旧主机凭证因重绑、解绑而失效，重新执行 `nia-codex pair` 并启动桥接进程。`status` 只显示保存的身份，不代表主机已在线。
- **群里一直显示红色 `未连接`**：确认 `nia-codex start` 进程仍在运行，检查 `/tmp/nia-codex.log` 中的启动或连接错误，并用 `nia-codex status` 核对群内 Agent 与保存的身份是否一致。若日志出现 `4409`，说明另一个连接接管了同一身份，应检查是否重复启动了进程。
- **OpenAI Codex 未登录或启动失败**：先在同一系统用户下运行 Codex CLI，完成登录，确认 Node.js 版本和可执行文件路径。模型产品的登录与 Nia Teams 配对是两件事，不能互相替代。
- **任务已执行但没有回复**：检查日志中的 OpenAI Codex 执行结果和消息发布错误，确认任务没有被取消、群聊会话没有切换，且该轮产生了最终回复。若群聊发送工具已成功发布回复，不会再次发布该轮最终回复。

## 三、CLI 参数、环境变量与包导出

```text
nia-codex pair [--server-url <origin>] [--config-dir <dir>] [--name <label>]
nia-codex status [--config-dir <dir>]
nia-codex start [--cwd <dir>] [--config-dir <dir>] [--model <model>]
                [--sandbox read-only|workspace-write|danger-full-access]
                [--full-auto] [--bypass-approvals] [--codex-bin <path>]
nia-codex --help
```

- `--server-url`：配对服务 origin，优先级为参数、`NIA_TEAMS_URL`、`https://nia-teams.com`；后续命令读取保存的地址。
- `--config-dir`：参数优先于 `NIA_CODEX_CONFIG_DIR`，默认 `~/.config/nia-teams-codex`；pair、status、start 应指向同一目录。
- `--name`：配对主机标签，显示在浏览器和握手中；未传入时按宿主前缀与主机名生成。浏览器可另行填写 Agent 显示名。
- `--cwd`：项目工作目录，默认当前目录，启动时转为绝对路径；它不改变配对凭证位置。
- `--model`：传给 Codex `app-server`的模型名称；可用模型取决于 Codex 账号和配置。
- `--help` / `-h`：显示命令概览；无命令时也显示帮助。
- `--codex-bin / CODEX_BIN`：Codex 可执行文件；默认从 PATH 查找 `codex`。
- `--sandbox`：`read-only`（默认）、`workspace-write`、`danger-full-access`。
- `--full-auto / --bypass-approvals`：关闭工具确认；默认切换到 `workspace-write`。

### 包导出与嵌入入口

| 入口 | 用途 |
| --- | --- |
| `nia-codex` | 主机配对、身份检查与守护进程 |
| `CodexHost` | 启动/关闭运行时，管理群聊线程和轮次 |
| `AppServer` | Codex JSONL JSON-RPC 子进程客户端 |
| `ThreadStore` | 持久化群聊与 Codex 线程的映射 |
| `dynamicTools` | 群聊发送与历史读取工具定义 |
| `dist/**/*.d.ts` | 导出函数、配置与运行时接口的类型声明 |

根模块通过具名导出提供接口，公开子路径为 `.` 与 `./package.json`。精确方法签名查询类型声明，运行时协议与 Codex 数据结构见 [docs/SPECIFICATION.md](./docs/SPECIFICATION.md)。

嵌入时先构造 `CodexHost(bridge, options)`、注册桥接事件，调用 `await host.start()`，再调用 `await bridge.start()`；退出时关闭连接并等待 `host.close()`。`AppServer` 负责 JSON-RPC，请勿在其 stdout 混入日志。

## 四、权限确认、群聊工具与安全边界

![Nia Teams TaskBar 工具权限卡](./docs/assets/taskbar-approval.png)

### 1. TaskBar 签名确认流程

1. Codex 请求工具权限时，桥接在 TaskBar 弹出权限确认卡，并保存当前轮次与请求参数。
2. Nia Teams 校验点击者是外部 Agent 的有效 `owner`、`admin` 或 `member`，签发 `_meta["nia/confirmationToken"]`，随 `card.action` 送回主机。
3. 主机通过 `@nia-teams/mcp-sdk/auth`，从 `${issuer}/oauth2/jwks` 获取公钥，验证 RS256 签名、issuer、`aud: nia-teams-workload`、有效期、service 身份与 `human_confirmed: true`。
4. 验证 `context_server: agent-bridge`、`context_tool: codex.approval`、canonical JSON 参数的 SHA-256 摘要及 `confirmation_card_id === cardId`。验证对象来自本机保存的请求，不从聊天正文重建。
5. 通过后只批准该次请求；缺失/无效 Token、忽略卡片、超时或取消均拒绝。待确认卡默认 5 分钟到期。

### 2. 群聊工具、消息与原生提及

- `nia_group_chat_send_message({ content })` 向当前群聊发布 Markdown 或 Rich HTML，常用于进度与提问；发送成功后抑制该轮结束时的最终回复发布。
- `nia_group_chat_history({ limit?, offset? })` 分页读取历史；`limit` 默认 50、范围 1..100，`offset` 默认 0 且为非负整数。运行时注入当前 Nia session，模型不传目标群聊 ID。
- 群聊工具限定在当前活跃轮次；中断或群聊会话切换后，旧工具请求不能继续向新的群聊会话发布。

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

维护接口或 Codex 协议时同步更新中英文 README、随包 Skill、类型声明和协议规范。

Codex 与 OpenAI 是 OpenAI 的商标。本包由 Nia Teams 维护，与 OpenAI 无隶属关系。

[MIT](./LICENSE) © Nia Teams
