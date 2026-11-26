# @nia-teams/workbuddy-plugin

English | [简体中文](./README_CN.md)

Connect **WorkBuddy (CodeBuddy)** into [Nia Teams](https://nia-teams.com) as an Agent in Nia Teams with **two-way communication**.

```sh
npm install -g @nia-teams/workbuddy-plugin
nia-workbuddy pair --name 'My WorkBuddy / CodeBuddy'
nia-workbuddy start --cwd "." --daemon --model "<model-id>"
```

Replace `<model-id>` with a concrete model ID available to your account, such as `glm-5.3`. You can omit `--model` if `CODEBUDDY_MODEL` is set.

AI coding agents: load [skills/nia-teams-workbuddy/SKILL.md](./skills/nia-teams-workbuddy/SKILL.md); installed path: `node_modules/@nia-teams/workbuddy-plugin/skills/nia-teams-workbuddy/SKILL.md`.

For terminal QR setup with WeChat and optional GroupChat invites, see [WeChat connect](../../docs/WECHAT-CONNECT.md).

## 1. Product Overview & Collaboration Model

The package runs tasks through the CodeBuddy Agent SDK using local desktop or CLI authentication. Each GroupChat retains its session.

- **Create and bind in one flow, without precreating an Agent or distributing static keys**: Start pairing on the WorkBuddy / CodeBuddy host, sign in to Nia Teams from a browser on any device, create the external Agent, and bind the host public key. The private key stays on the host.
- **Live presence and per-GroupChat conversation history**: The composer activity strip shows disconnected, idle, executing, or waiting state. Each chat retains its own CodeBuddy session for later turns; the host workspace is shared.
- **Follow-up questions**: The Agent can ask the person who started the task for input in GroupChat.

![Nia Teams GroupChat and Agent activity](./docs/assets/group-chat-overview.png)

| Concern | Local host | This package | Nia Teams |
| --- | --- | --- | --- |
| Agent runtime | Models, tools, workspace, CodeBuddy sign-in | Chat-to-runtime sessions, queries, cancellation | External Agent identity and scope |
| Connection and auth | Local Node process and WorkBuddy desktop app or CodeBuddy CLI | Ed25519 credentials, WebSocket, reconnection | Browser pairing, challenge/lease, delivery |
| Conversation | Inference turns and local tasks | Prompt formatting, session resume, publication | Timeline, members, activity |
| Approval and safety | CodeBuddy tool permissions and execution scope | Full-auto by default; signed TaskBar cards in opt-in mode | TaskBar, Agent membership, signed approvals |

## 2. Five-Step Quick Start

Prerequisites: Node.js 20+, a signed-in WorkBuddy desktop app or CodeBuddy CLI, and a Nia Teams account. No external Agent needs to be created in advance.

### Step 1: Install the bridge and prepare the host

Sign in to the WorkBuddy desktop app, then install:

```sh
npm install -g @nia-teams/workbuddy-plugin
```

Discovery covers PATH, `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`, the user Applications directory, and common CLI locations. If a desktop distribution includes `dist/codebuddy-lite-wb.mjs`, the bridge selects that readable ESM entry for the SDK instead of opening the desktop wrapper. Standalone CodeBuddy installations retain their own entry.

Desktop credential decryption runs the app’s Electron with `ELECTRON_RUN_AS_NODE=1` and an empty inherited `NODE_OPTIONS`. This Node mode does not start desktop UI or steal macOS window focus. Decrypted values stay in memory; concurrent requests share decryption, and credential-file mtime changes trigger refresh. Existing plaintext sign-in or an explicit `CODEBUDDY_AUTH_TOKEN` skips Electron decryption.

For standalone CodeBuddy CLI, complete that CLI’s own login, then select it through PATH, `CODEBUDDY_BIN`, or `--codebuddy-bin`. The SDK executable option is `pathToCodebuddyCode`; the bridge retains `user`, `project`, and `local` settings and CodeBuddy authentication from the local environment.

### Step 2: Pair the host and create an Agent in the browser

```sh
nia-workbuddy status
```

Check the saved `Agent:`, `Server:`, and config directory first. Reuse an existing intended binding; pair for first setup or an intentional Agent change:

```sh
nia-workbuddy pair --name 'My WorkBuddy / CodeBuddy'
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

Wait for `Paired: <Agent name> (@external-...)` and exit code `0` in the terminal. After proving private-key possession, the host saves `credentials.json` under `~/.config/nia-teams-workbuddy/`, using POSIX `0700` directory and `0600` file modes. Pairing is independent of the project directory; later startup reads the same config directory.

```sh
nia-workbuddy status
```

`status` shows the saved identity and server; verify the running connection through the daemon and GroupChat presence in the next steps.

### Step 3: Start the daemon

For manual operation, run in an interactive foreground terminal with logs visible:

```sh
nia-workbuddy start --cwd /path/to/workspace --model "<model-id>"
```

For detached operation or local AI setup, launch in the background:

```sh
# Portable background launch (Windows PowerShell/CMD/Git Bash, macOS, Linux):
nia-workbuddy start --cwd "/path/to/workspace" --daemon --model "<model-id>"

# POSIX-only alternative (not Windows):
nohup nia-workbuddy start --cwd /path/to/workspace --model "<model-id>" > /tmp/nia-workbuddy.log 2>&1 &
sleep 2
cat /tmp/nia-workbuddy.log
pgrep -af '[n]ia-workbuddy.*start'
```

Startup opens an authenticated connection to `wss://nia-teams.com/ws/agent-bridge`. Network interruptions reconnect with exponential backoff. Run one bridge per paired config directory. On macOS, `caffeinate` prevents system sleep while a task runs and is released when the task finishes.

GroupChats have separate model contexts but share the files, repository, and local tools under `--cwd`. Credentials and session records are stored separately in `credentials.json` and `threads.json`.

#### SDK sessions, tool requests, and questions

Private `threads.json` stores each GroupChat’s CodeBuddy session ID and workspace. Changing `--cwd` starts a fresh runtime session in that chat without changing its pairing. If a resumed query ends without a result before using any tools, the bridge tries once with a fresh session. Authentication failures require signing in again. `SessionHost` serializes turns within a chat and queues incoming messages. Nia session rotation aborts the old query and clears old inputs. Each chat admits up to 64 queued messages by default; input admission and outgoing publication queues are separate.

SDK system, assistant, and result events drive session persistence and activity only. Terminal output stays on the host; GroupChat replies are published through `send_message`.

`AskUserQuestion` posts to GroupChat and waits for the task’s invoking human. Reply with text for one question; for multiple questions, use JSON keyed by question text, such as `{"Target branch":"main","Run tests":"yes"}`. Timeout or cancellation returns a deny result to the CodeBuddy Agent SDK.

CodeBuddy allow rules and hooks from user, project, and local settings remain effective. Full-auto selects `bypassPermissions`; `--require-approval` selects `default`. Already-allowed tools may not reach the SDK permission callback. CodeBuddy authentication belongs to the model host; Nia pairing does not replace CodeBuddy login.

### Step 4: Invite the external Agent and verify presence

Click **Go to GroupChat** on the pairing confirmation page, or open Nia Teams **Messages** in the left navigation:

- **Start a new conversation**: Click the external Agent avatar in the quick strip above the chat list; expand the strip when it overflows. The `+` at its right creates a multi-person GroupChat.
- **Invite into an existing chat**: Open the GroupChat, click `+` beside member avatars in the upper-right header, select the Agent in **Invite existing members**, and click **Done**.
- **Invitation roles**: Organization members can invite organization-affiliated Agents. The creator initially invites a Personal Assistant; other members of that GroupChat may then invoke it.

Watch the activity strip above the composer: red **Disconnected** changes to **Idle / Ready** when the host connects. Match the chat Agent to the identity shown by `status`, then send a short task to verify a reply.

### Step 5: Mention the Agent and manage its lifecycle

Type `@` in the composer and select the external Agent. Its activity becomes executing while the task runs, and replies appear in GroupChat. Incoming prompts include title, URL, members, sender, messages, and attachment transcripts. Notify a person with their ID: `<mention userId="24-hex-id" />`, rather than plain `@Name`.

- **Temporary offline**: Press `Ctrl+C` in the foreground terminal or run `nia-workbuddy stop` for a background daemon (include the same `--config-dir` if set). Presence becomes **Disconnected**. Restart loads existing credentials and session mappings.
- **Move or unpair a host**: An Agent `owner` / `admin` pairs the new host and selects **Rebind existing external Agent**. To unpair only, use **Apps → Agent Settings → Unpair host** in a shared chat’s upper-right header. Rebind/unpair increments `keyGeneration` to invalidate old host credentials and disconnects the old host with `4401`. A competing connection taking over the same identity closes the old connection with `4409`, stopping reconnects.
- **Deactivate and archive**: When no other contacts remain and you are the sole `owner`, use **Agent Settings → Deactivate “Agent name” → Confirm**. Archiving revokes the Agent’s online connections.

### Troubleshooting

- **Startup reports a missing model or rejects a model alias**: Use CodeBuddy’s `/model` to find an available model and pass its concrete ID with `--model` or `CODEBUDDY_MODEL`. To pair without starting, use `nia-workbuddy connect --no-start`.
- **Pairing request expired**: Links last 10 minutes. Run `nia-workbuddy pair` again on the host and open the new URL.
- **status fails**: Check OS user, config directory, file permissions, and completed pairing. A locally operated re-pair may be needed after rebind/unpair; diagnose network and origin failures before replacing credentials.
- **Chat stays red Disconnected**: Inspect the daemon log (`daemon.log` in the config directory by default), saved Server, and chat Agent identity. Check for another process using the credentials. Close code `4409` means another connection took over.
- **CodeBuddy login or startup fails**: Run the WorkBuddy desktop app or CodeBuddy CLI under the same OS user, sign in, and verify Node version and binary selection. CodeBuddy sign-in and Nia pairing are separate.
- **Execution without a reply**: Check the daemon log for runtime or publication errors, and verify the turn was not canceled or interrupted by session rotation.

## 3. CLI, Environment & Package Exports

```text
nia-workbuddy connect [--cwd <dir>] [--require-approval] [--model <model-id>] [--no-start] [--group-link <url-or-token>]
nia-workbuddy pair [--server-url <origin>] [--config-dir <dir>] [--name <label>]
nia-workbuddy status [--config-dir <dir>]
nia-workbuddy stop [--config-dir <dir>]
nia-workbuddy start [--cwd <dir>] [--config-dir <dir>] [--model <model-id>]
                   [--require-approval] [--codebuddy-bin <path>]
nia-workbuddy --help
```

- `--server-url`: Pairing origin; precedence is flag, `NIA_TEAMS_URL`, then `https://nia-teams.com`. Later commands use the saved origin.
- `--config-dir`: Explicit path overrides `NIA_WORKBUDDY_CONFIG_DIR` and defaults to `~/.config/nia-teams-workbuddy`. Use the same directory for pair, status, start, and stop.
- `--name`: Pairing host label shown in browser and handshake; omission generates a host-prefixed machine label. The Agent display name can be changed in the browser.
- `--cwd`: Project working directory; defaults to the current directory and resolves to an absolute path. It does not move credentials.
- `--model` / `CODEBUDDY_MODEL`: Starting the daemon, including via `connect`, requires a concrete model ID available to your account. `--model` takes precedence over `CODEBUDDY_MODEL`; surrounding whitespace is trimmed. Auto routing (`auto`, `auto-chat`, `fast-model`, `balanced-model`, `deep-model`) can lead to repeated MCP tool calls in long conversations. The bridge rejects those IDs as well as the generic aliases `default-model` and `primary-model`. `connect --no-start`, `pair`, `status`, and `stop` do not require a model.
- `--help` / `-h`: Show command overview; no command also displays help.
- `--codebuddy-bin / CODEBUDDY_BIN`: Select a CodeBuddy executable or readable `.mjs` / `.js` entry. On Windows, standard WorkBuddy installations under Program Files and Local AppData are detected automatically.
- `--require-approval`: Review tool permission requests from the runtime in TaskBar.

For compatibility, `--full-auto` matches the default and cannot be combined with `--require-approval`.

### Exports and embedding

| Entrypoint | Purpose |
| --- | --- |
| `nia-workbuddy` | Pairing, identity inspection, and daemon |
| `createWorkBuddyRunner` | Create an SDK runner for SessionHost |
| `resolveCodeBuddyBinary` | Locate the standalone CLI or desktop entry |
| `SessionHost` | GroupChat queues, session resume, cancellation, and approvals |
| `dist/**/*.d.ts` | Exported functions, options, and runtime interfaces |

The root module provides named exports; public export-map paths are `.` and `./package.json`. Read declarations for exact signatures and [docs/SPECIFICATION.md](./docs/SPECIFICATION.md) for runtime and CodeBuddy contracts.

For embedding, pass `createWorkBuddyRunner(options)` to core `runSessionDaemon`, or own a `SessionHost` lifecycle. SDK queries and GroupChat tools share the active turn scope; models do not choose a destination chat.

## 4. Approvals, GroupChat Tools & Security Boundaries

### 1. Opt-in signed TaskBar approvals

Full-auto is the default because per-tool approvals would add too many cards to GroupChat during normal coding turns. For per-tool confirmation, pass `--require-approval` to `connect` or `start`.

![Nia Teams TaskBar 工具权限卡](./docs/assets/taskbar-approval.png)

1. A CodeBuddy tool permission request opens a TaskBar confirmation card bound to the current turn and request arguments.
2. Nia Teams checks that the clicker is an active Agent `owner`, `admin`, or `member`, then signs `_meta["nia/confirmationToken"]` and returns it with `card.action`.
3. The host uses `@nia-teams/mcp-sdk/auth` and keys from `${issuer}/oauth2/jwks` to verify RS256 signature, issuer, `aud: nia-teams-workload`, lifetime, service identity, and `human_confirmed: true`.
4. It checks `context_server: agent-bridge`, `context_tool: workbuddy.approval`, canonical-JSON argument SHA-256 digest, and `confirmation_card_id === cardId`. Expected values come from the locally stored request, not chat text.
5. A valid result allows only that request. Missing/invalid tokens, dismissal, expiry, and cancellation deny it. Pending cards expire after five minutes by default.

### 2. GroupChat tools, messages, and native mentions

Nia Teams supplies the available collaboration tools, including chat management, reminders, and shared links. The runtime exposes them through its native tool interface.

- `send_message({ content })` publishes Markdown or Rich HTML to the current GroupChat for progress or questions. All replies require an explicit send; turn-end text stays private.
- `chat_history({ limit?, offset? })` paginates history; `limit` defaults to 50 in 1..100, and `offset` defaults to 0 and must be non-negative. The host supplies the Nia session; the model does not choose a chat ID.

- GroupChat tools belong to the active turn. After interruption or Nia session rotation, old requests cannot publish into the new GroupChat session.

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

Update both READMEs, the shipped skill, declarations, and protocol specification when changing runtime interfaces or CodeBuddy contracts.

WorkBuddy and CodeBuddy are Tencent product names. This package is maintained by Nia Teams and is not affiliated with Tencent.

[MIT](./LICENSE) © Nia Teams
