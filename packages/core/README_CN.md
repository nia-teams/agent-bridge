# @nia-teams/agent-bridge-core

[English](./README.md) | 简体中文

把任意外部 Agent 运行时接入到 [Nia Teams](https://nia-teams.com) 里，使其成为一个 Nia Teams 里的 Agent 并实现**双向通讯**的 Node.js 核心 SDK。

```sh
npm install @nia-teams/agent-bridge-core
```

AI 指引：[skills/agent-bridge-core/SKILL.md](./skills/agent-bridge-core/SKILL.md) · `node_modules/@nia-teams/agent-bridge-core/skills/agent-bridge-core/SKILL.md`。

## 一、核心概念

`pairHost` 保存主机 Ed25519 凭证，`BridgeClient` 通过 challenge/lease 建立 WebSocket，适配器处理群聊轮次，`PublicationQueue` 发布回复。模型、工具与本地权限由接入方运行时负责。

| 接入方运行时 | 本包 | Nia Teams |
| --- | --- | --- |
| 模型、工具、工作目录与会话 | 配对、认证、重连与发布 | 群聊身份、消息路由与活动状态 |
| 执行或拒绝工具请求 | 验证 TaskBar 签名确认 | 成员校验、审批卡与签名 |
| 自携带 `clientName` / PNG `avatar` | 在配对与每次 lease 握手上报通用品牌字段 | 通过轻量头像 URL 展示配对页与群聊身份 |

## 客户端名称与头像

客户端适配器自携带产品名称 `clientName` 和 PNG 头像 `avatar`，通过
`pairHost({ clientName, avatar, ...options })` 在 `pairing/start` 上报，并通过
`new BridgeClient(credentials, { clientName, avatar })` 在每次 `lease` 握手/重连时上报。
`SessionHostOptions` / `runSessionDaemon` 也支持这两个可选字段。自定义 Node.js Agent
可传入自己的品牌信息；Core 和 Teams 不维护客户端枚举，新增客户端无需修改服务端。

`clientName` trim 后为 1–80 字符且不含控制字符；`avatar` 仅允许
`data:image/png;base64,...`，解码后的 PNG 文件 ≤64 KiB、尺寸 ≤1024×1024，不接受 SVG
或远程图片 URL。配对页与群聊身份自动展示对应图标；已配对 Agent 升级并启动后，
通过验证的 lease 自动同步品牌信息，无需重新配对。省略 lease 字段不清空已有品牌，
用户自定义头像优先。API 只返回轻量头像 URL，不内联图片数据。

完整约束见 [协议](./docs/SPECIFICATION.md)。使用品牌功能时，在配对和连接两个入口
都传入字段；浏览器批准不提前覆盖主机品牌，完成私钥持有证明后才提交。

## 二、快速开始

需要 Node.js 20+。以下示例使用 ESM，可保存为 `.mjs` 后以 `node` 运行。

### 1. 配对主机

```js
import { defaultConfigDir, pairHost } from '@nia-teams/agent-bridge-core';

await pairHost({
  configDir: defaultConfigDir('my-agent', 'MY_AGENT_CONFIG_DIR'),
  hostLabel: 'my-agent',
  onPairing: ({ verificationUrl }) => console.log(verificationUrl),
});
```

运行后在浏览器打开输出的 URL，创建或重绑外部 Agent。后续连接读取已有凭证。

### 2. 接收群聊消息并回复

```js
import { BridgeClient, defaultConfigDir, loadCredentials } from '@nia-teams/agent-bridge-core';

const configDir = defaultConfigDir('my-agent', 'MY_AGENT_CONFIG_DIR');
const bridge = new BridgeClient(await loadCredentials(configDir), {
  onError: error => console.error(error.message),
});
bridge.onThreadMessage(async frame => {
  await bridge.rpc('group_chat.send_message', {
    sessionId: frame.sessionId,
    toolCallId: frame.deliveryId,
    content: 'Received',
  });
});
bridge.onThreadCancel(() => {});
bridge.onCardAction(() => {});
bridge.onReady(frame => console.log('Connected:', frame.agent.slug));
process.once('SIGINT', () => bridge.close());
process.once('SIGTERM', () => bridge.close());
await bridge.start();
```

随包示例可运行：

```sh
node node_modules/@nia-teams/agent-bridge-core/examples/pair.mjs
node node_modules/@nia-teams/agent-bridge-core/examples/connect.mjs
```

## 三、模块导出

| 子路径 | 用途 |
| --- | --- |
| `/types` | 凭证、推送帧与 RPC 类型 |
| `/crypto` | Ed25519 签名与确定性线程 ID |
| `/credentials` | 私有凭证的校验与原子读写 |
| `/pairing` | pairHost、runPairingCli、acquireLease |
| `/bridge-client` | BridgeClient、BridgeRpcError |
| `/publications` | 有界幂等发布队列 PublicationQueue |
| `/format` | formatThreadMessage 群聊提示格式 |
| `/http` | 服务地址校验与 HTTP 请求 |
| `/state` | JsonFileStore、ThreadMapStore 与私有状态路径 |
| `/process` | IdleSleepGuard 与可执行文件发现 |

根入口另提供以下运行时服务：

| 导出 | 用途 |
| --- | --- |
| `SessionHost` | 群聊输入队列、会话恢复、取消、人工问答与确认卡 |
| `runSessionDaemon` | 装配 BridgeClient 与 SessionHost，管理信号退出 |
| `consumeSdkQuery` | 消费 SDK 事件并提取最终回复 |
| `ThreadMapStore` | 按群聊保存接入方运行时的会话标识 |
| `IdleSleepGuard` | macOS 上任务执行期间通过 `caffeinate` 防止系统休眠 |

类型签名见 `dist/**/*.d.ts`；报文与签名规则见 [docs/SPECIFICATION.md](./docs/SPECIFICATION.md)。

## 四、权限边界

- 凭证按适配器选择配置目录；POSIX 目录权限 `0700`、文件权限 `0600`，加载时校验私钥与路径。
- 在 start() 前注册推送处理器；所有处理器成功后才确认投递。
- 执行卡片对应操作前，调用 verifyCardApproval 并传入预期卡片、工具与参数，验证 RS256 人类确认。
- PublicationQueue 使用幂等键重试进程内待发布消息；队列不跨进程保存。
- 原始消息的发送者 ID 位于 messages[].authorId；成员 ID 位于 groupChat.members[].id。原生提及使用 `<mention userId="24-hex-id" />`。
- 会话 ID 映射不构成文件系统或操作系统隔离。

## 五、开发验证与许可证

```sh
npm install
npm run build
npm run typecheck
npm test
```

[MIT](./LICENSE) © Nia Teams
