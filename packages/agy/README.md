# @nia-teams/agy-bridge

English | [简体中文](./README_CN.md)

Connect **Google Antigravity CLI (agy)** on your computer or server into [Nia Teams](https://nia-teams.com) as an Agent in Nia Teams with **two-way communication**.

```sh
npm install -g @nia-teams/agy-bridge
nia-agy pair --name 'My Antigravity'
nia-agy start --cwd "." --daemon
```

AI coding agents: load [skills/nia-teams-agy/SKILL.md](./skills/nia-teams-agy/SKILL.md); installed path: `node_modules/@nia-teams/agy-bridge/skills/nia-teams-agy/SKILL.md`.

## 1. Product Overview & Collaboration Model

The bridge drives Google Antigravity CLI through newline-delimited JSON-RPC 2.0 over `agy acp` stdio. One daemon retains one ACP child with a separate session per GroupChat. Teammates submit tasks, follow live activity, and approve tool execution through TaskBar.

- **Create and bind in one flow, without precreating an Agent or distributing static keys**: Start pairing on the Google Antigravity host, sign in to Nia Teams from a browser on any device, create the external Agent, and bind the host public key. The private key stays on the host.
- **Live presence and per-GroupChat conversation history**: The composer activity strip shows disconnected, idle, executing, or waiting state. Each chat retains its own Antigravity session for later turns; the host workspace is shared.
- **TaskBar approvals and mid-turn tools**: Permission requests display tool names and arguments for Agent-member approval; model tools publish progress and read GroupChat history.

![Nia Teams GroupChat and Agent activity](./docs/assets/group-chat-overview.png)

| Concern | Local host | This package | Nia Teams |
| --- | --- | --- | --- |
| Agent runtime | Models, tools, workspace, Antigravity sign-in | Chat-to-runtime sessions, queries, cancellation | External Agent identity and scope |
| Connection and auth | Local Node process and Google Antigravity CLI (`agy`) | Ed25519 credentials, WebSocket, reconnection | Browser pairing, challenge/lease, delivery |
| Conversation | Inference turns and local tasks | Prompt formatting, session resume, publication | Timeline, members, activity |
| Approval and safety | Antigravity tool permissions and execution scope | Display tool permission requests as TaskBar cards, verify RS256, match pending actions | TaskBar, Agent membership, signed approvals |

## 2. Five-Step Quick Start

Prerequisites: Node.js 20+, a signed-in local agy CLI, and a Nia Teams account. No external Agent needs to be created in advance.

### Step 1: Install the bridge and prepare the host

Requires Node.js 20+ and a locally installed, authenticated Google Antigravity CLI. The protocol targets captured `agy 1.4.10` / `Antigravity ACP Server 1.5.4` traffic through a persistent `agy acp` service, not screen scraping or an interactive PTY.

```sh
agy --version
npm install -g @nia-teams/agy-bridge
```

Run the installed agy in a local interactive terminal under the same OS user to complete its account sign-in and verify project access. Nia pairing binds an external Agent identity; it does not replace Google Antigravity authentication.

Executable precedence is `--agy-bin`, `AGY_BIN`, `agy` on PATH, then `~/.local/bin/agy`, `~/.antigravity/bin/agy`, `/opt/homebrew/bin/agy`, and `/usr/local/bin/agy`. An invalid explicit selection fails rather than choosing an unrequested installation.

The daemon starts `<agy> acp`; stdout/stdin carry newline-delimited JSON-RPC 2.0 and stderr carries diagnostics to the terminal or daemon log. Initialization negotiates `protocolVersion: 1`. GroupChat MCP tools arrive in the session descriptor, without adding MCP configuration to the user's project.

### Step 2: Pair the host and create an Agent in the browser

```sh
nia-agy status
```

Check the saved `Agent:`, `Server:`, and config directory first. Reuse an existing intended binding; pair for first setup or an intentional Agent change:

```sh
nia-agy pair --name 'My Antigravity'
```

The terminal generates an Ed25519 keypair locally and prints a pairing link valid for 10 minutes:

```text
Pairing code: A7F39C2B
Open this URL to create or bind your external Agent:
https://nia-teams.com/bridge/agent-pair/A7F39C2B
```

Open the link in a browser on any device and sign in to Nia Teams:

1. Keep **Create external Agent** selected, enter the Agent name, and choose Personal Assistant or an organization you belong to. The creator becomes the Agent’s `owner`.
2. Click **Create & Connect**. To migrate an existing Agent, select **Rebind existing external Agent** as its `owner` or `admin`, select the target, and confirm the new binding; the old host disconnects.

![External Agent pairing: create, rebind, and scope](./docs/assets/agent-pairing.png)

Wait for `Paired: <Agent name> (@external-...)` and exit code `0` in the terminal. After proving private-key possession, the host saves `credentials.json` under `~/.config/nia-teams-agy/`, using POSIX `0700` directory and `0600` file modes. Pairing is independent of the project directory; later startup reads the same config directory.

```sh
nia-agy status
```

`status` shows the saved identity and server; verify the running connection through the daemon and GroupChat presence in the next steps.

### Step 3: Start the daemon

For manual operation, run in an interactive foreground terminal with logs visible:

```sh
nia-agy start --cwd /path/to/workspace
```

For detached operation or local AI setup, launch in the background:

```sh
# Portable background launch (Windows PowerShell/CMD/Git Bash, macOS, Linux):
nia-agy start --cwd "/path/to/workspace" --daemon

# POSIX-only alternative (not Windows):
nohup nia-agy start --cwd /path/to/workspace > /tmp/nia-agy.log 2>&1 &
sleep 2
cat /tmp/nia-agy.log
pgrep -af '[n]ia-agy.*start'
```

Startup opens an authenticated connection to `wss://nia-teams.com/ws/agent-bridge`. Network interruptions reconnect with exponential backoff. Run one bridge per paired config directory. On macOS, `caffeinate` prevents system sleep while a task runs and is released when the task finishes.

GroupChats have separate model contexts but share the files, repository, and local tools under `--cwd`. Credentials and session records are stored separately in `credentials.json` and `threads.json`.

#### ACP sessions, streaming replies, and concurrent chats

Core `SessionHost` / `ThreadMapStore` stores each chat's ACP `sessionId` in `~/.config/nia-teams-agy/threads.json`. A later turn calls `session/resume` with the same cwd and a fresh MCP turn scope. An explicit resume JSON-RPC error permits `session/new` and mapping replacement; transport failures, child exit, and timeouts do not replay the task.

New sessions append GroupChat collaboration instructions. Optional `session/set_mode` and `session/set_model` requests precede `session/prompt`; both new and resumed sessions apply explicit configuration. Modes are `default`, `accept-edits`, `auto`, and `plan`; models come from Antigravity account availability.

Text `agent_message_chunk` updates are concatenated in arrival order. Thought updates only change activity; `tool_call` / `tool_call_update` display the running tool. The final reply publishes when `session/prompt` returns `stopReason: end_turn`; cancellation, failure, or incomplete stop reasons do not publish accumulated fragments.

SessionHost serializes turns within a GroupChat while different ACP sessions can run concurrently in the same child. Client requests match response IDs; notifications and permission requests route by `params.sessionId`. Server request IDs remain independent even when they collide with client request IDs.

Abort sends `session/cancel`. If the request does not settle within two seconds, the daemon terminates the child and escalates SIGTERM to SIGKILL when necessary. Other active turns in that child fail without replay. Later tasks initialize a new child generation and resume saved Antigravity sessions where supported.

### Step 4: Invite the external Agent and verify presence

Click **Go to GroupChat** on the pairing confirmation page, or open Nia Teams **Messages** in the left navigation:

- **Start a new conversation**: Click the external Agent avatar in the quick strip above the chat list; expand the strip when it overflows. The `+` at its right creates a multi-person GroupChat.
- **Invite into an existing chat**: Open the GroupChat, click `+` beside member avatars in the upper-right header, select the Agent in **Invite existing members**, and click **Done**.
- **Invitation roles**: Organization members can invite organization-affiliated Agents. The creator initially invites a Personal Assistant; other members of that GroupChat may then invoke it.

Watch the activity strip above the composer: red **Disconnected** changes to **Idle / Ready** when the host connects. Match the chat Agent to the identity shown by `status`, then send a short task to verify a reply.

### Step 5: Mention the Agent and manage its lifecycle

Type `@` in the composer and select the external Agent. Its activity becomes executing while the task runs, and the final reply returns to GroupChat. Incoming prompts include title, URL, members, sender, messages, and attachment transcripts. Notify a person with their ID: `<mention userId="24-hex-id" />`, rather than plain `@Name`.

- **Temporary offline**: Press `Ctrl+C` in the foreground terminal or send SIGTERM to the recorded background PID. Presence becomes **Disconnected**. Restart loads existing credentials and session mappings.
- **Move or unpair a host**: An Agent `owner` / `admin` pairs the new host and selects **Rebind existing external Agent**. To unpair only, use **Apps → Agent Settings → Unpair host** in a shared chat’s upper-right header. Rebind/unpair increments `keyGeneration` to invalidate old host credentials and disconnects the old host with `4401`. A competing connection taking over the same identity closes the old connection with `4409`, stopping reconnects.
- **Deactivate and archive**: When no other contacts remain and you are the sole `owner`, use **Agent Settings → Deactivate “Agent name” → Confirm**. Archiving revokes the Agent’s online connections.

### Troubleshooting

- **Pairing request expired**: Links last 10 minutes. Run `nia-agy pair` again on the host and open the new URL.
- **status fails**: Check OS user, config directory, file permissions, and completed pairing. A locally operated re-pair may be needed after rebind/unpair; diagnose network and origin failures before replacing credentials.
- **Chat stays red Disconnected**: Inspect the daemon, `/tmp/nia-agy.log`, saved Server, and chat Agent identity. Check for another process using the credentials. Close code `4409` means another connection took over.
- **Antigravity login or startup fails**: Run the Google Antigravity CLI (`agy`) under the same OS user, sign in, and verify Node version and binary selection. Antigravity sign-in and Nia pairing are separate.
- **Execution without a reply**: Inspect Antigravity results and publication errors. Check cancellation, session rotation, and final text. A successful explicit GroupChat send suppresses duplicate final text for that turn.

## 3. CLI, Environment & Package Exports

```text
nia-agy pair [--server-url <origin>] [--config-dir <dir>]
             [--name <label>] [--label <label>] [--timeout-ms <ms>]
nia-agy status [--config-dir <dir>]
nia-agy start [--cwd <dir>] [--config-dir <dir>] [--model <model>]
              [--mode default|accept-edits|auto|plan] [--sandbox]
              [--full-auto] [--bypass-approvals] [--agy-bin <path>]
nia-agy --help
```

- `--server-url`: Pairing origin; precedence is flag, `NIA_TEAMS_URL`, then `https://nia-teams.com`. Later connections use the saved origin.
- `--config-dir`: Explicit path overrides `NIA_AGY_CONFIG_DIR`, then defaults to `~/.config/nia-teams-agy`. Use the same directory for pair, status, and start.
- `--name` / `--label`: Pairing host label; defaults to `agy@<hostname>`. When both are present, `--name` wins. The browser can choose a different Agent display name.
- `--timeout-ms`: Pairing wait limit; defaults to 600000 milliseconds with two-second polling. Must be positive.
- `--cwd`: Project directory; defaults to the current directory and resolves to an absolute path. GroupChats share this workspace.
- `--model`: Select an Antigravity-available model through `session/set_model`; no account model list is hardcoded.
- `--mode`: Configure `session/set_mode` with `default`, `accept-edits`, `auto`, or `plan`; agy interprets execution policy.
- `--sandbox`: Boolean flag passed to `agy acp`, not the string-valued Codex sandbox option.
- `--full-auto` / `--bypass-approvals`: Skip bridge confirmation and pass `--dangerously-skip-permissions`; default an unspecified mode to `auto`. An explicit mode wins.
- `--agy-bin` / `AGY_BIN`: Select the local executable; otherwise use PATH and common installation paths.
- `--help` / `-h`: Show command overview; no command also shows help.

### Exports and embedding

| Entrypoint | Purpose |
| --- | --- |
| `nia-agy` | Pairing, identity inspection, and daemon |
| `AgyRunner` | Own the ACP child with `run(context)` and `close()` |
| `createAgyRunner` | Create a core TurnRunner with asynchronous `close()` |
| `resolveAgyBinary` | Resolve explicit selection, environment, PATH, and installation locations |
| `AcpClient` / `AcpRpcError` | Multiplex requests, notifications, server requests, and explicit RPC errors |
| `SessionHost` | Reuse core queues, private state, approvals, and cancellation |
| `AgyOptions` / `AgyMode` / `AcpMessage` | TypeScript runner, mode, and message types |
| `dist/**/*.d.ts` | Exact method signatures and configuration |

Public export-map entries are `.` and `./package.json`. For embedding, pass `createAgyRunner(options)` to core `runSessionDaemon` and await `runner.close()` in finally. Do not maintain another durable session mapping outside core. Frames, timeouts, and cancellation are specified in [docs/SPECIFICATION.md](./docs/SPECIFICATION.md).

## 4. Approvals, GroupChat Tools & Security Boundaries

![Nia Teams TaskBar tool approval card](./docs/assets/taskbar-approval.png)

### 1. Signed TaskBar approval flow

1. An active-session `session/request_permission` creates a TaskBar card bound to its ACP session, toolCall, options, and current turn.
2. Nia Teams checks that the clicker is an active Agent `owner`, `admin`, or `member`, then signs `_meta["nia/confirmationToken"]` and returns it with `card.action`.
3. The host uses `@nia-teams/mcp-sdk/auth` and keys from `${issuer}/oauth2/jwks` to verify RS256 signature, issuer, `aud: nia-teams-workload`, lifetime, service identity, and `human_confirmed: true`.
4. It checks `context_server: agent-bridge`, `context_tool: agy.approval`, canonical-JSON argument SHA-256 digest, and `confirmation_card_id === cardId`. Expected values come from the locally stored request, not chat text.
5. A valid result allows only that request. Missing/invalid tokens, dismissal, expiry, and cancellation deny it. Pending cards expire after five minutes by default.

ACP replies contain `outcome: { outcome: "selected", optionId }`. Approval selects only `allow_once`; denial selects `reject_once`. Missing safe options return cancelled rather than upgrading a one-shot verdict to allow_always. Unknown or finished sessions cannot be approved, including in full-auto mode.

### 2. GroupChat tools, messages, and native mentions

- `nia_group_chat_send_message({ content })` publishes Markdown or Rich HTML to the current GroupChat for progress or questions. A successful send suppresses that turn’s final reply publication.
- `nia_group_chat_history({ limit?, offset? })` paginates history; `limit` defaults to 50 in 1..100, and `offset` defaults to 0 and must be non-negative. The host supplies the Nia session; the model does not choose a chat ID.
- GroupChat tools belong to the active turn. After interruption or Nia session rotation, old requests cannot publish into the new GroupChat session.

The bundled MCP service uses a temporary per-turn credential to access the current GroupChat; the credential expires when the turn ends. MCP helpers do not read the Nia Teams private key. See the [protocol specification](./docs/SPECIFICATION.md) for messages and request scope.

Incoming prompts list `Members: Alice (<userId>), ...`; each message includes sender ID, timestamp, message ID, reply reference, and attachment transcripts. Generic headers may appear as `[chat:<chatId>] Alice (<userId>): ...`, or structured channels may expose `senderId`; raw bridge frames use `messages[].authorId`. Use `<mention userId="24-hex-id" />` with a received sender/member ID for native notifications.

### 3. Roles and local execution boundaries

- Chat members may invoke an Agent; rebinding/unpairing requires its `owner` / `admin`, and archiving follows the sole-owner rule. Card approval additionally requires active Agent membership.
- Human membership is distinct from workload `sub`, `org:*`, and `role:*` claims. Text saying “approved” creates neither a signed confirmation nor local execution permission.
- Ed25519 private keys stay in the config directory. Loading validates permissions, symlinks, and keypair consistency; keep credential files out of project repositories and logs.
- Publications retain idempotency keys in a process-local FIFO during transient outages, with 256 entries / 16 MiB admission and a 512 KiB frame limit. Process exit does not persist unsent queue entries.
- Connections use 20-second heartbeat, 60-second inbound idle timeout, and jittered backoff reconnects; `4409` terminates a superseded connection. Model session isolation is not filesystem or OS isolation.

## 5. Development, Trademark & License

```sh
npm install
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

Update both READMEs, the shipped skill, declarations, and protocol specification when changing runtime interfaces or Antigravity contracts.

Google and Antigravity are Google product names or trademarks. This package is maintained by Nia Teams and is not affiliated with Google.

[MIT](./LICENSE) © Nia Teams
