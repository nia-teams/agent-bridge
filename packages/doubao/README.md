# @nia-teams/doubao-bridge

English | [简体中文](./README_CN.md)

Connect **Doubao Work**, the **Doubao desktop app**, or the **official Doubao CLI** into [Nia Teams](https://nia-teams.com) as an Agent in Nia Teams with **two-way communication**.

```sh
npm install -g @nia-teams/doubao-bridge
nia-doubao pair --name 'My Doubao'
nia-doubao start --cwd "." --daemon
```

AI coding agents: load [skills/nia-teams-doubao/SKILL.md](./skills/nia-teams-doubao/SKILL.md); installed path: `node_modules/@nia-teams/doubao-bridge/skills/nia-teams-doubao/SKILL.md`.

## 1. Product Overview & Collaboration Model

Desktop mode reads signed-in cookies through local CDP and runs tasks through an HTTP local runtime. Official CLI mode runs local processes and hands login to the interactive terminal. Both retain per-GroupChat sessions.

- **Create and bind in one flow, without precreating an Agent or distributing static keys**: Start pairing on the Doubao host, sign in to Nia Teams from a browser on any device, create the external Agent, and bind the host public key. The private key stays on the host.
- **Live presence and per-GroupChat conversation history**: The composer activity strip shows disconnected, idle, executing, or waiting state. Each chat retains its own Doubao session for later turns; the host workspace is shared.
- **Doubao execution permissions**: Desktop authentication supplies the HTTP runtime; official CLI mode uses terminal authentication. Doubao permission modes govern execution while GroupChat displays activity and final replies.

![Nia Teams GroupChat and Agent activity](./docs/assets/group-chat-overview.png)

| Concern | Local host | This package | Nia Teams |
| --- | --- | --- | --- |
| Agent runtime | Models, tools, workspace, Doubao sign-in | Chat-to-runtime sessions, queries, cancellation | External Agent identity and scope |
| Connection and auth | Local Node process and Doubao desktop client or Doubao CLI | Ed25519 credentials, WebSocket, reconnection | Browser pairing, challenge/lease, delivery |
| Conversation | Inference turns and local tasks | Prompt formatting, session resume, publication | Timeline, members, activity |
| Approval and safety | Doubao tool permissions and execution scope | Preserve Doubao permission modes and auth source | Chat identity and message access checks |

## 2. Five-Step Quick Start

Prerequisites: Node.js 22+, a signed-in Doubao desktop client or Doubao CLI, and a Nia Teams account. No external Agent needs to be created in advance.

### Step 1: Install the bridge and prepare the host

Install the bridge, then choose a local sign-in source:

```sh
npm install -g @nia-teams/doubao-bridge
```

| Mode | Host and authentication | Task execution |
| --- | --- | --- |
| Desktop `work` | `/Applications/DoubaoWork.app`; CDP port 9226 | HTTP local runtime |
| Desktop `doubao` | `/Applications/Doubao.app`; CDP port 9225 | HTTP local runtime |
| Official CLI `cli` | `@bytedance/doubao-cli`; local terminal login | Official CLI child process |
| HTTP `headless` | Preconfigured independent HTTP sign-in | Explicit local or cloud runtime |

**Desktop client mode**: Sign in to the selected app. The bridge reads cookies through local CDP `Network.getAllCookies` and passes them to the HTTP local runtime. Tasks do not manipulate window DOM, navigate pages, or change focus. Authentication is checked at startup and before each turn. Starting a stopped app may open its window; restarting a running app requires `--restart-app` authorization.

**Official CLI mode**: Install `npm install -g @bytedance/doubao-cli`. Interactive bridge startup checks `auth status --verify`; missing authentication starts `login` with QR code in that same terminal, then verifies sign-in before connecting to Nia Teams. Before detached startup, run `doubao login` locally. QR codes stay in the local terminal.

`auto` selects CLI for explicit `--doubao-bin`; otherwise it prefers Doubao Work, Doubao App, then official CLI. Native CLI discovery checks the OS application-data runtime before PATH and excludes the HTTP driver’s similarly named wrapper. `headless` must be selected explicitly.

### Step 2: Pair the host and create an Agent in the browser

```sh
nia-doubao status
```

Check the saved `Agent:`, `Server:`, and config directory first. Reuse an existing intended binding; pair for first setup or an intentional Agent change:

```sh
nia-doubao pair --name 'My Doubao'
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

Wait for `Paired: <Agent name> (@external-...)` and exit code `0` in the terminal. After proving private-key possession, the host saves `credentials.json` under `~/.config/nia-teams-doubao/`, using POSIX `0700` directory and `0600` file modes. Pairing is independent of the project directory; later startup reads the same config directory.

```sh
nia-doubao status
```

`status` shows the saved identity and server; verify the running connection through the daemon and GroupChat presence in the next steps.

### Step 3: Start the daemon

For manual operation, run in an interactive foreground terminal with logs visible:

```sh
nia-doubao start --cwd /path/to/workspace
```

For detached operation or local AI setup, launch in the background:

```sh
# Portable background launch (Windows PowerShell/CMD/Git Bash, macOS, Linux):
nia-doubao start --cwd "/path/to/workspace" --daemon

# POSIX-only alternative (not Windows):
nohup nia-doubao start --cwd /path/to/workspace > /tmp/nia-doubao.log 2>&1 &
sleep 2
cat /tmp/nia-doubao.log
pgrep -af '[n]ia-doubao.*start'
```

Startup opens an authenticated connection to `wss://nia-teams.com/ws/agent-bridge`. Network interruptions reconnect with exponential backoff. Run one bridge per paired config directory. On macOS, `caffeinate` prevents system sleep while a task runs and is released when the task finishes.

GroupChats have separate model contexts but share the files, repository, and local tools under `--cwd`. Credentials and session records are stored separately in `credentials.json` and `threads.json`.

#### Local runtime, session resume, and cancellation

Desktop mode defaults to `--runtime local` and passes absolute `--cwd` as the local workspace. Both desktop apps create work-mode conversations; later messages inherit the existing mode. `--runtime cloud` does not mount the local project; local cwd is then only the process directory.

Local permissions default to `AskOnRisk`: ordinary workspace reads may run, while commands, writes, and outside-workspace access require Doubao approval. Unattended HTTP execution denies those requests without interactive consent. Explicit `--full-auto` supplies the Doubao callback granting `FullAccess` for that invocation, allowing local shell and file operations. It is not an OS sandbox and does not create TaskBar approval cards.

`threads.json` stores backend-prefixed IDs: `work:<conversationId>`, `doubao:<conversationId>`, `cli:<sessionId>`, and `headless:<conversationId>`. Only matching backend IDs resume. Switching backend starts a new conversation while retaining Nia pairing. Desktop cookies refresh before each turn; stopping a run uses the same cookie snapshot captured for that turn.

An HTTP task runs in one local worker that waits for completion. Accepted conversation/run IDs are recorded as soon as available. GroupChat cancellation stops the accepted remote run before ending the worker. Publication requires matching conversation/run IDs, completed status, and nonempty reply text. Official CLI cancellation targets its local process group; its sessions are separate from HTTP tasks.

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

- **Pairing request expired**: Links last 10 minutes. Run `nia-doubao pair` again on the host and open the new URL.
- **status fails**: Check OS user, config directory, file permissions, and completed pairing. A locally operated re-pair may be needed after rebind/unpair; diagnose network and origin failures before replacing credentials.
- **Chat stays red Disconnected**: Inspect the daemon, `/tmp/nia-doubao.log`, saved Server, and chat Agent identity. Check for another process using the credentials. Close code `4409` means another connection took over.
- **Doubao login or startup fails**: Run the Doubao desktop client or Doubao CLI under the same OS user, sign in, and verify Node version and binary selection. Doubao sign-in and Nia pairing are separate.
- **Execution without a reply**: Inspect Doubao results and publication errors. Check cancellation, session rotation, and final text. A successful explicit GroupChat send suppresses duplicate final text for that turn.

## 3. CLI, Environment & Package Exports

```text
nia-doubao pair [--server-url <origin>] [--config-dir <dir>] [--name <label>]
nia-doubao status [--config-dir <dir>]
nia-doubao start [--cwd <dir>] [--config-dir <dir>] [--model <model>]
                [--platform auto|work|doubao|cli|headless]
                [--runtime local|cloud] [--full-auto] [--restart-app]
                [--doubao-bin <official-binary>]
nia-doubao --help
```

- `--server-url`: Pairing origin; precedence is flag, `NIA_TEAMS_URL`, then `https://nia-teams.com`. Later commands use the saved origin.
- `--config-dir`: Explicit path overrides `NIA_DOUBAO_CONFIG_DIR` and defaults to `~/.config/nia-teams-doubao`. Use the same directory for pair, status, and start.
- `--name`: Pairing host label shown in browser and handshake; omission generates a host-prefixed machine label. The Agent display name can be changed in the browser.
- `--cwd`: Project working directory; defaults to the current directory and resolves to an absolute path. It does not move credentials.
- `--model`: Model name passed to the selected Doubao runtime; available models depend on the Doubao account and settings.
- `--help` / `-h`: Show command overview; no command also displays help.
- `--platform`: `auto` (default), `work`, `doubao`, `cli`, or `headless`.
- `--runtime`: `local` or `cloud` for desktop/HTTP mode; desktop defaults to `local`.
- `--doubao-bin`: Official CLI path; an explicit binary makes auto select cli.
- `--restart-app`: Authorize startup restart of a desktop app without CDP.
- `--full-auto`: Use FullAccess for HTTP local tasks and always_allow for the official CLI.
- `DOUBAO_CDP_ENDPOINT`: Override desktop CDP with a loopback HTTP origin belonging to the selected app.

### Exports and embedding

| Entrypoint | Purpose |
| --- | --- |
| `nia-doubao` | Pairing, identity inspection, and daemon |
| `createDoubaoRunner` | Create a runner; ready() checks authentication and runtime |
| `resolveDoubaoPlatform / resolveDoubaoBinary` | Select the backend and HTTP driver |
| `resolveNativeDoubaoBinary` | Locate the official CLI |
| `resumeForBackend / SessionHost` | Resume backend-specific GroupChat sessions and manage turns |
| `dist/**/*.d.ts` | Exported functions, options, and runtime interfaces |

The root module provides named exports; public export-map paths are `.` and `./package.json`. Read declarations for exact signatures and [docs/SPECIFICATION.md](./docs/SPECIFICATION.md) for runtime and Doubao contracts.

For embedding, create `createDoubaoRunner(options)`, await `runner.ready()` for Doubao authentication, then pass it to core `runSessionDaemon`. `resumeForBackend` accepts only the selected backend prefix; Nia `sessionId` is not an Doubao conversation ID.

## 4. Approvals, GroupChat Tools & Security Boundaries

![Nia Teams TaskBar (tool approvals for Codex, Claude Code, WorkBuddy, DSH, and Antigravity)](./docs/assets/taskbar-approval.png)

### 1. Doubao permissions and the TaskBar protocol

The local HTTP runtime uses `AskOnRisk` / `FullAccess` or official CLI `ask_always` / `always_allow` modes. This adapter does not provide a Doubao tool-to-TaskBar approval callback. The image shows Nia Teams approval UI used by adapters with TaskBar permission confirmation. The shared Agent Bridge signature contract below does not replace Doubao authorization with chat text or UI appearance.

1. A consumer creating an approval card stores the binding between card and request.
2. Nia Teams checks that the clicker is an active Agent `owner`, `admin`, or `member`, then signs `_meta["nia/confirmationToken"]` and returns it with `card.action`.
3. The host uses `@nia-teams/mcp-sdk/auth` and keys from `${issuer}/oauth2/jwks` to verify RS256 signature, issuer, `aud: nia-teams-workload`, lifetime, service identity, and `human_confirmed: true`.
4. It checks `context_server: agent-bridge`, the expected tool name, canonical-JSON argument SHA-256 digest, and `confirmation_card_id === cardId`. Expected values come from the locally stored request, not chat text.
5. Only a consumer with the corresponding runtime approval callback can apply that verdict to a tool request.

### 2. GroupChat tools, messages, and native mentions

Desktop HTTP and official CLI return task text to the runner, which publishes through the shared queue. This package does not inject MCP GroupChat tools into the Doubao model. `nia_group_chat_send_message` / `nia_group_chat_history` are collaboration interfaces for dynamic-tool or MCP adapters; custom consumers can call the corresponding bridge RPCs.

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

Update both READMEs, the shipped skill, declarations, and protocol specification when changing runtime interfaces or Doubao contracts.

Doubao is a ByteDance product name. This package is maintained by Nia Teams and is not affiliated with ByteDance.

[MIT](./LICENSE) © Nia Teams
