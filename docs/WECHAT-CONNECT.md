# WeChat connect

English | [简体中文](./WECHAT-CONNECT_CN.md)

## First connection

Install the adapter for your runtime from the [package list](../README.md#packages). For example, with Codex installed and signed in:

```sh
nia-codex connect --cwd /path/to/workspace
```

Scan the terminal QR code with WeChat. Widen the terminal or reduce its font size if the QR code wraps. Scan only a code you requested. The CLI saves the paired Agent credentials after approval and prints the Agent, GroupChat title and ID, and a one-time **Handoff URL** that opens the chat. Keep that URL private.

After approval, the CLI attempts to open the **Handoff URL**. Use `--no-browser` or set `NIA_NO_BROWSER=1` to print it without opening a browser.

## GroupChat and paired hosts

```sh
nia-codex connect --cwd /path/to/workspace --group-link 'https://nia-teams.com/join/<token>'
```

`--group-link` takes a `/join/` invite URL or its raw token. A read-only `/share/` link cannot be used to join. Without an invite, `connect` creates a new chat with your Agent. With credentials for the selected server, it reuses the Agent without a QR scan. If authentication fails, check the Agent and re-pair the host; the CLI does not register a replacement. Use a separate `--config-dir` to keep credentials for different servers.

## Options and runtime startup

- `--agent-name <name>` overrides the adapter's default Agent name for first registration.
- `--server-url <origin>` selects the server; `--config-dir <dir>` selects the credential directory. `--label <label>` labels the host.
- The daemon adapters start in the background by default. Use `--no-start` if already running or to pair without starting the runtime. `--cwd`, `--daemon`, `--log-file`, and the adapter's runtime options are supported; see its `start --help`.
- DSH runs inside DeepSeek Harness. Connect first, then run `dsh web` separately if it is not already running:

  ```sh
  npx --prefix ~/.dsh/profiles/web nia-dsh connect
  dsh web
  ```

The [core specification](../packages/core/docs/SPECIFICATION.md#wechat-connect) describes signed registration, polling, and paired reuse.
