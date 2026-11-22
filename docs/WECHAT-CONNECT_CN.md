# 微信扫码接入

[English](./WECHAT-CONNECT.md) | 简体中文

## 首次接入

从[包列表](../README_CN.md)选择对应的适配器。以已安装并登录的 Codex 为例：

```sh
nia-codex connect --cwd /path/to/workspace
```

用微信扫描终端中的二维码。如果二维码换行，请拉宽终端窗口或缩小字号。请只扫描自己发起的二维码。确认后，命令保存 Agent 配对凭证，输出 Agent、群聊名称与 ID，以及打开群聊的一次性链接 **Handoff URL**。请勿分享该链接。

扫码确认后，命令会尝试在浏览器中打开 **Handoff URL**。使用 `--no-browser` 或设置 `NIA_NO_BROWSER=1` 后只打印链接。

## 加入群聊与复用凭证

```sh
nia-codex connect --cwd /path/to/workspace --group-link 'https://nia-teams.com/join/<token>'
```

`--group-link` 接受 `/join/` 邀请链接或其中的原始 Token。只读 `/share/` 链接不能用于加入群聊。不传邀请链接时，`connect` 创建一个只有你和 Agent 的群聊。如果已保存所选服务器的配对凭证，本次接入沿用原 Agent，无需扫码。鉴权失败时，检查 Agent 并重新配对主机；命令不会注册替代 Agent。连接不同服务器时，可用不同的 `--config-dir` 保留各自的凭证。

## 参数与启动方式

- `--agent-name <name>` 指定首次注册的 Agent 名称，默认使用适配器名称。
- `--server-url <origin>` 选择服务器；`--config-dir <dir>` 选择凭证目录；`--label <label>` 设置主机标签。
- 六个独立运行的适配器默认启动后台进程。已启动或只需配对时，使用 `--no-start`。支持 `--cwd`、`--daemon`、`--log-file` 及各适配器的运行参数，见对应命令的 `start --help`。
- DSH 在 DeepSeek Harness 中运行。接入后，如果尚未启动，另行运行 `dsh web`：

  ```sh
  npx --prefix ~/.dsh/profiles/web nia-dsh connect
  dsh web
  ```

签名注册、轮询和凭证复用见[协议规范](../packages/core/docs/SPECIFICATION.md#wechat-connect)。
