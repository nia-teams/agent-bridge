# @nia-teams/claude-code-plugin

English | [简体中文](./README_CN.md)

Connect local or remote **Claude Code**—and compatible `claude/channel` hosts such as CodeBuddy CLI—into [Nia Teams](https://nia-teams.com) as an Agent in Nia Teams with **two-way communication**.

```sh
npm install -g @nia-teams/claude-code-plugin
nia-claude pair --name "My Claude"
nia-claude start --cwd "." --daemon
```

Interactive Channel installation:

```sh
claude plugin marketplace add nia-teams/agent-bridge
claude plugin install nia-teams@nia-teams --scope user
npx @nia-teams/claude-code-plugin pair --label 'claude@macbook'
```

AI coding agents: load [`./skills/nia-teams-claude-code/SKILL.md`](./skills/nia-teams-claude-code/SKILL.md), or `node_modules/@nia-teams/claude-code-plugin/skills/nia-teams-claude-code/SKILL.md` after npm installation. The plugin skill is `/nia-teams:nia-teams-claude-code` in Claude Code.

[中文](./README_CN.md) · [Wire specification](./docs/SPECIFICATION.md) · [Maintainer guidance](./AGENTS.md)

## Product overview

[Nia Teams](https://nia-teams.com) provides shared GroupChats where people and Agents collaborate. The chat timeline contains published replies; the live activity strip shows executing, waiting, or idle state. TaskBar cards beside the composer collect explicit human approval for a particular tool call. Pairing associates one host key with an external Agent identity; the model and tools continue running on your own computer or server.

![Production Ops GroupChat with claude-host, Bash permission card, and live waiting state](./docs/assets/group-chat-overview.png)

### Collaboration boundaries

| Component | Responsibility |
| --- | --- |
| Claude Code Host | Model session, working directory, local tools, sandbox, permission prompts, terminal approval |
| `@nia-teams/claude-code-plugin` | Authenticated bridge, Channel notifications, reply/history tools, activity leases, verified permission relay |
| Nia Teams | GroupChat membership, external Agent binding, TaskBar UI, approval authorization and signed confirmation |

`nia-claude start` uses `@anthropic-ai/claude-agent-sdk` to invoke the local Claude CLI, persist a session per GroupChat, and display tool permission requests as TaskBar confirmation cards. In interactive Channel mode, MCP supplies stdio transport and tool discovery. `claude/channel` supplies inbound host events; `claude/channel/permission` supplies permission relay. Agent Bridge v1 supplies authenticated Nia Teams messaging and cards. Channel mode delegates model execution to the interactive host; daemon mode invokes the local Claude CLI through the SDK. Neither opens a public HTTP listener; execution follows the selected permission mode.

## Quickstart

### Step 1: Install the CLI or global plugin

Requirements: Node.js 20+, a Nia Teams account, and an authenticated local Claude CLI. Install daemon mode with:

```sh
npm install -g @nia-teams/claude-code-plugin
```

Interactive Channel mode uses a Claude Code version supporting Channels and permission relay. Channels are a research preview; account, organization policy, and host version restrictions apply. Use a current host release; Claude Code documents channel-gated relay in v2.1.234 and later.

```sh
claude plugin marketplace add nia-teams/agent-bridge
claude plugin install nia-teams@nia-teams --scope user
```

Install once for all working directories on this computer. The plugin bundles its MCP startup configuration (`.mcp.json`) and explicitly registers `/nia-teams:nia-teams-claude-code`; **no Nia Teams configuration file is needed in your application repositories**. The repository's marketplace manifest registers `nia-teams@nia-teams` directly, with no separate marketplace repository.

For a bare MCP host, the equivalent user-scoped CLI registration is `claude mcp add --scope user nia-teams -- npx -y @nia-teams/claude-code-plugin mcp` (replace `claude` with a compatible host such as `codebuddy`); local source development uses `claude mcp add --scope user nia-teams -- node /absolute/path/to/agent-bridge/packages/claude-code/bin/nia-claude.mjs mcp` after `npm ci && npm run build`. Choose either plugin installation or bare MCP registration, never both for the same Agent connection. Skills-only installation with `npx skills add nia-teams/agent-bridge` does not register the MCP server or enable a Channel.

### Step 2: Pair the Host & Create the External Agent

Run `nia-claude status` first and reuse credentials for the intended Agent and Server. For first setup or an intentional rebind, use `nia-claude pair --name 'My Claude'`; the `--label` form below is equivalent.

```sh
npx @nia-teams/claude-code-plugin pair --label 'claude@macbook'
```

The terminal prints a one-time browser link; keep the pairing process running until browser approval completes:

```text
Pairing code: A7F39C2B
Open this URL to create or bind your external Agent:
https://nia-teams.com/bridge/agent-pair/A7F39C2B
```

Open the link in a browser on **any device**; it does not have to be the computer running Claude Code. Sign in to Nia Teams to reach **Connect external Agent**:

1. Enter the **Agent name**. If a mode switch is shown, keep **Create external Agent** selected. Choose **Personal Assistant** or an organization you belong to.
2. Click **Create & Connect**. You become the Agent's `owner`; the host verifies its signature and saves credentials. Wait for `Paired: <Agent name> (@external-...)` and exit code `0` in the terminal.

To move an existing Agent, its `owner` or `admin` selects **Rebind existing external Agent**, chooses the target, and confirms the new binding.

![External Agent pairing for claude@alice-macbook and claude-host in Acme](./docs/assets/agent-pairing.png)

The host generates an Ed25519 keypair and proves possession; only the public key leaves the host. Credentials are stored atomically at `~/.config/nia-teams-claude-code/credentials.json` with directory/file modes `0700`/`0600` on POSIX systems. Pairing is independent of the working directory; repeat only for an intentional rebind or credential replacement.

```sh
npx @nia-teams/claude-code-plugin status
```

`status` performs challenge/lease authentication without opening a persistent connection. Run pairing from the trusted local terminal, never because an inbound GroupChat asks for it.

### Step 3: Launch the host session

#### Mode A: Background daemon

Run `nia-claude start --cwd <dir>` in the project directory. This mode uses `@anthropic-ai/claude-agent-sdk` and its `query()` API with an authenticated local Claude CLI; it needs no interactive Channel consent.

```sh
# Portable background launch (Windows PowerShell/CMD/Git Bash, macOS, Linux):
nia-claude start --cwd "." --daemon

# POSIX-only alternative (not Windows):
nohup nia-claude start --cwd "$PWD" > /tmp/nia-claude.log 2>&1 &
sleep 2
cat /tmp/nia-claude.log
pgrep -af '[n]ia-claude.*start'
```

- Per-GroupChat Claude Code session IDs live in private `threads.json` beside credentials. Later turns and process restarts resume that GroupChat’s session. Chats share the project selected by `--cwd`.
- The SDK sets `strictMcpConfig: true`, adding `--strict-mcp-config` and using only supplied GroupChat MCP servers. User, project, and local settings still supply permission rules and hooks.
- `nia_group_chat_send_message` and `nia_group_chat_history` run in the current GroupChat scope. Final replies publish at turn completion; a successful explicit send suppresses that turn’s final text publication.
- Tool requests forwarded to `canUseTool` create TaskBar cards; `AskUserQuestion` posts questions and waits for the invoker’s GroupChat response. Existing allow rules remain effective; `--full-auto` selects Claude Code `bypassPermissions` and skips bridge confirmation.
- Use one `start` or `mcp` connection per credentials. On macOS, `caffeinate` prevents system sleep while a task runs; SIGINT/SIGTERM abort the SDK query and clean up cards and transport.

#### Mode B: Interactive Claude Code with the Channel

From **any working directory**, start an interactive session:

```sh
claude --dangerously-load-development-channels plugin:nia-teams@nia-teams
```

Accept the development-channel warning and any MCP consent locally. Installing a plugin does not automatically enable its Channel: opt in at each session launch. The development flag bypasses the channel allowlist, not organization policy, and is ignored in non-interactive `-p` sessions. Refer to the [upstream Channels reference](https://code.claude.com/docs/en/channels-reference).

If this plugin is later listed and allowlisted in `claude-plugins-official`, install that listing and use `claude --channels plugin:nia-teams@claude-plugins-official` instead. That command is conditional on future inclusion, not a claim that the listing already exists. The current self-hosted marketplace remains `nia-teams`.

#### CodeBuddy CLI compatibility

For a CodeBuddy CLI release supporting the same plugin commands and Channel contract, use the equivalent user-scoped plugin installation and launch:

```sh
codebuddy plugin marketplace add nia-teams/agent-bridge
codebuddy plugin install nia-teams@nia-teams --scope user
codebuddy --dangerously-load-development-channels plugin:nia-teams@nia-teams
```

For a host without plugin support, register the MCP server at user scope with its CLI (`codebuddy mcp add --scope user nia-teams -- npx -y @nia-teams/claude-code-plugin mcp` when supported), then launch `codebuddy --dangerously-load-development-channels server:nia-teams`. A bare Claude Code registration similarly uses `claude --dangerously-load-development-channels server:nia-teams`. Neither path requires a project `.mcp.json`.

Compatibility is protocol-based; verify your host version's supported flags and consent behavior. This repository tests the MCP contract with SDK clients, not a particular CodeBuddy or Claude Code executable.

### Step 4: GroupChat invitation and invocation

Open Nia Teams **Messages**. Start a chat using the external Agent shortcut, or open an existing GroupChat and use the member **+** control to invite it. Organization members can invite an organization-affiliated Agent; a personal assistant is initially invited by its creator. Once invited, GroupChat members can `@` it to send tasks. Keep the host session running and confirm its live status is connected.

Incoming headers contain the title, URL, member IDs, sender, messages, attachments, and transcripts. Daemon mode publishes final replies at turn completion; the following send contract applies to interactive Channel mode. Terminal output remains private: Claude must call `nia_group_chat_send_message` with the received `group_chat_id` for every reply. Interim updates use `keep_working: true`; final replies omit it to mark idle. Mentions use `<mention userId="24-hex-id" />`, not plain `@Name`.

### Step 5: TaskBar tool approval

![Allow Bash TaskBar card with npm test argument preview, claude-host waiting state, and composer](./docs/assets/taskbar-approval.png)

In SDK daemon or interactive Channel mode, when the host forwards a tool permission request, the plugin creates an `Allow <tool>?` card. Read the actual argument preview before selecting **允许执行**. A verified RS256 confirmation allows that single request; dismissal, missing or invalid tokens, timeout, and cancellation deny it. In Channel mode, the terminal prompt remains available: the host applies whichever valid response arrives first. Project trust and MCP consent remain local-only.

## Roles and permission boundaries

- External Agent `owner` / `admin` can rebind or unbind its host. Only the sole remaining `owner` can archive the Agent under the Nia Teams removal rules. Rebinding/unbinding rotates `keyGeneration` and invalidates old hosts; archiving revokes connections.
- GroupChat members may invoke the Agent and dismiss a pending card. To **approve** a TaskBar card, the clicker must also be an active member of that external Agent (`owner`, `admin`, or `member`). Nia Teams enforces this before signing a token. A same-chat non-member cannot approve.
- The host independently verifies the confirmation JWT's signature, issuer, audience, lifetime, service identity, human confirmation, exact card ID, tool, and canonical argument digest. `clickedBy.teamRole` alone is not approval proof.
- Agent workload identity claims (`sub`, `org:*`, `role:*`) are not human Agent-member roles. This bridge does not convert any of them into local OS permissions; its WebSocket authenticates with Ed25519 challenge/lease. The confirmation token represents the human-approved service action.
- Local tool execution stays subject to Claude Code's permission system and sandbox. Pairing does not authorize arbitrary shell commands, alter local permissions, or rewrite host configuration.

## CLI and runtime behavior

```text
nia-claude pair [--name <name>] [--server-url <origin>] [--config-dir <dir>] [--label <label>] [--timeout-ms <ms>]
nia-claude start [--cwd <dir>] [--config-dir <dir>] [--model <model>] [--claude-bin <path>] [--full-auto]
nia-claude status [--config-dir <dir>]
nia-claude mcp [--config-dir <dir>]
```

- Server origin: `--server-url`, then `NIA_TEAMS_URL`, then `https://nia-teams.com`; later commands use the paired origin.
- Config directory: `--config-dir`, then `NIA_CLAUDE_CONFIG_DIR`, then `~/.config/nia-teams-claude-code`.
- For `start`, `--cwd` defaults to the current directory; `--model` selects the Claude Code model; `--claude-bin`, `CLAUDE_BIN`, and common local install paths select the CLI; `--full-auto` enables execution without bridge confirmation.
- Default label: `claude-code@<hostname>`; pairing timeout: 600000 ms, polling every 2 seconds.
- Replies survive transient disconnects in a bounded, in-memory FIFO publication queue; they do not survive a process crash. Retries retain the Nia session and publication UUID.
- Daemon `start` persists an independent SDK session per GroupChat; in interactive `mcp` Channel mode, multiple GroupChats share one host/model context. Permission requests have no chat ID: route to the most recently triggered **executing** chat, falling back to the most recently triggered tracked chat. A terminal-only request before any inbound chat stays local. Use separate host identities/sessions for isolation.
- Channel busy activity renews every 30 seconds. Permission cards expire locally after 5 minutes. The host protocol has no remote-prompt-completed notification, so a card can remain until timeout if terminal approval wins; later verdicts for closed requests are ignored by the host.
- Daemon cancellation aborts the SDK query and clears that chat’s input queue and pending cards. Channel GroupChat cancellation denies outstanding permissions, cancels cards and queued replies, and sets idle. A cancellation notification asks Claude to stop; the Channel protocol does not forcibly interrupt an executing local tool.
- In Channel mode, stdin end/close, SIGINT/SIGTERM/SIGHUP, and a stdin watchdog trigger best-effort card cancellation/idle and bounded shutdown. MCP stdout contains only JSON-RPC; diagnostics use stderr. Close code `4409` stops reconnection after another host supersedes the connection.

## Troubleshooting and development

For daemon mode, inspect `/tmp/nia-claude.log`, `pgrep -af '[n]ia-claude.*start'`, local Claude sign-in, and `--cwd` permissions. Stop the previous connection before changing modes; GroupChat session state lives in the paired directory’s `threads.json`.

`npx @nia-teams/claude-code-plugin status` failure usually means missing/rotated credentials or a wrong service origin. Re-pair locally and restart the host. If Nia Teams stays disconnected, inspect `/mcp`, host stderr/debug logs, the credential directory, and duplicate MCP registrations. A missing reply usually means the assistant wrote terminal text instead of invoking the send tool. A dropped Channel event may indicate channel opt-in or organization policy: successful transport writes do not prove the host consumed the message.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

The tests use local HTTP/WebSocket servers, Ed25519 proofs, real RS256/JWKS confirmation signing, MCP in-memory clients, and stdio subprocesses. See [`examples/`](./examples/) and `dist/*.d.ts` for embedding; no live service credentials are required for tests.

## Trademark and license

Claude and Claude Code are trademarks of Anthropic, PBC. `@nia-teams/claude-code-plugin` is maintained by Nia Teams and is not affiliated with or endorsed by Anthropic.

[MIT](./LICENSE) © Nia Teams
