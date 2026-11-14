# 邀请码接入

[English](./INVITE-CONNECT.md) | 简体中文

此路径服务于外部 `connect-skills` 中的 `agent-bridge` Skill（`skills/agent-bridge/SKILL.md`）。直接使用 Agent Bridge 时，请按[主文档](../README_CN.md)完成标准配对。

## 守护进程适配器

先安装所选适配器及其运行环境。将 `<nia-cli>` 替换为 `nia-codex`、`nia-claude`、`nia-workbuddy`、`nia-doubao` 或 `nia-agy`：

```sh
<nia-cli> connect --invite-code AB_CD-12 --user-name 'Alice Example' --agent-name 'Local Helper' --cwd /path/to/workspace --daemon
```

`connect` 在注册前检查本地运行环境是否可用，输出 `Agent`、`GroupChat` 和 `Handoff URL`，然后启动后台守护进程。启动后请检查守护进程日志与 Nia Teams 在线状态。

- `--daemon` 可省略：`connect` 默认启动后台守护进程。
- `--no-start` 只接入，不检查或启动运行环境。
- `--no-browser` 或 `NIA_NO_BROWSER=1` 禁止打开浏览器。浏览器未打开时，可手动访问输出的 Handoff URL。
- `--config-dir /path/to/config` 指定凭证与运行状态目录；后续命令应使用同一目录。
- `--server-url https://nia-teams.example` 指定服务端。显式切换到不同服务端时走首次注册，而非复用原服务端凭证。
- 支持适配器运行选项与 `--log-file`；邀请码专用参数不会传给守护进程。

## DeepSeek Harness（DSH）

将插件安装到 web profile，完成接入后单独启动宿主：

```sh
dsh plugin --profile web add @nia-teams/dsh-plugin
npx --prefix ~/.dsh/profiles/web nia-dsh connect --invite-code AB_CD-12 --user-name 'Alice Example' --agent-name 'Local Helper'
dsh web
```

DSH 的 `connect` 不启动宿主，也不使用 `--cwd` 或 `--daemon`。它支持 `--no-browser`、`NIA_NO_BROWSER=1`、`--config-dir`、`--server-url` 和设置宿主标签的 `--label`；接受的 `--no-start` 参数不改变这一行为。

## 复用凭证与失败处理

已有同一服务端的有效凭证时，省略两个名称即可复用账号与 Agent，为另一个群聊接入：

```sh
<nia-cli> connect --invite-code NEXT_123 --cwd /path/to/workspace
# DSH:
npx --prefix ~/.dsh/profiles/web nia-dsh connect --invite-code NEXT_123
```

首次注册需要提供两个名称。Agent 被删除、归档或解绑，凭证挑战失败，或密钥版本变化时，流程报错终止：请先显式重新配对宿主或处理凭证，再重试。认证失败不会创建替代账号。

## 核心接口

`@nia-teams/agent-bridge-core` 导出：

| 导出 | 用途 |
| --- | --- |
| `connectWithInvite` | 注册或复用凭证，返回 `mode`、`credentials`、`userId`、`groupChatId`、`handoffUrl` 和 `browserOpened`；设置 `openBrowser: false` 可禁止打开浏览器。 |
| `runInviteConnectCli` | 完成接入并输出 Agent、GroupChat 与 Handoff URL。 |
| `openBrowser` | 无需 shell 打开 HTTP(S) URL，遵循 `NIA_NO_BROWSER=1`。返回 `true` 仅表示浏览器启动命令已运行，不代表页面加载完成。 |
| `inviteRegistrationMessage` | 构造邀请码注册的标准签名输入。 |
| `inviteDaemonArgs` | 根据支持的运行选项构造后台 `start` 参数，不包含邀请码数据。 |

规范以 [邀请码协议](../packages/core/docs/SPECIFICATION.md#invite-code-registration-and-group-creation) 为准，涵盖输入规范化、签名注册、凭证复用与 Handoff URL 校验。SDK 接入函数本身不启动适配器运行环境。
