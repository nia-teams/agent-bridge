# Factory Droid SDK contract

The adapter uses `@factory/droid-sdk@0.10.0`, entrypoint `@factory/droid-sdk/node`. Factory Droid v1.13.0 was probed for native SDK sessions and browser/device login. Agent Bridge signing and transport remain in [the core specification](https://github.com/nia-teams/agent-bridge/blob/main/packages/core/docs/SPECIFICATION.md).

## Process and authentication

`ProcessTransport({ droidExecPath, cwd, env })` spawns `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`; the SDK owns protocol framing, requests, and notifications. The bridge inherits the local environment and sets `DROID_DISABLE_AUTO_UPDATE=true`.

The adapter connects `ProcessTransport` before passing it as `transport` to `createSession` / `resumeSession`. This uses Factory's existing browser login or inherited `FACTORY_API_KEY`. Calling those helpers without an explicit transport requires an API key even when the CLI is browser-authenticated.

The SDK spawns `execPath` without a shell or interpreter prefix. Native binaries work on all supported operating systems. POSIX script entrypoints need executable permissions and a shebang. Windows JavaScript and batch launchers are rejected; select the native executable. Discovery uses core `findExecutable` and respects `--droid-bin` / `DROID_BIN`.

## Session lifecycle

- `createSession`: `cwd`, optional `modelId`, `reasoningEffort`, `autonomyLevel`, and `systemPrompt: { type: 'preset', preset: 'droid', append: context.systemPrompt }`.
- `resumeSession(id, options)` loads persisted settings through `droid.load_session`. It does not accept a replacement system prompt. Explicit CLI model/effort/autonomy use `session.updateSettings` after load; omitted settings remain unchanged.
- `context.session(session.id)` saves the raw local session ID before streaming. `context.resume` supplies that ID on subsequent turns.
- Only `SessionNotFoundError` (load error code `-32004`) permits reconnecting and creating a fresh session before prompting. Other load errors propagate. A failed stream never replays a prompt.
- Each turn supplies fresh context-scoped `mcpServers` and callbacks to both create and resume. Collaboration policy appended to the system prompt is persisted on initial creation; later server reminders arrive as the current user prompt.
- `session.stream(context.prompt, { abortSignal: context.signal })` yields private assistant text and tool activity. A terminal `result` must report `success: true` and `subtype: 'success'`; other outcomes fail the turn.
- Cancellation uses the SDK abort signal, which sends `droid.interrupt_session`. Finally the bridge closes the session, transport, and SDK MCP server, including initialization/error paths. In SDK 0.10.0 `DroidClient.close()` also closes externally supplied transports; explicit cleanup is idempotent.

## Native JSON-RPC evidence

Frames are JSONL with `jsonrpc: '2.0'`, `factoryApiVersion: '1.0.0'`, optional `factoryProtocolVersion`, and `type: 'request' | 'response' | 'notification'`. A session starts with `droid.initialize_session`; later processes use `droid.load_session`. `droid.add_user_message` includes a `messageId` used as the turn ID. `droid.session_notification` carries `params.notification`; `agent_turn_completed` must match that turn ID and include completion reason plus token usage.

The integration mock speaks these native messages to the real Factory SDK. It also opens the SDK's authenticated loopback HTTP MCP endpoint using an MCP client. No alternate execution protocol is implemented in the adapter.

## Permissions and questions

`permissionHandler(params)` receives `toolUses`, each containing `toolUse`, `confirmationType`, and `details`, plus offered options. The bridge bypasses separate TaskBar cards only for its two `nia` tools. Other requests call `context.permission('droid:<tool>', input, signal)`; input contains the original tool arguments under `input`, plus confirmation type and details. Prefixing names keeps runtime tools separate from core's `AskUserQuestion` dispatch. A batch proceeds only when every non-collaboration request is allowed. Responses select `ToolConfirmationOutcome.ProceedOnce` (`proceed_once`) or `Cancel` (`cancel`), never a persistent allow option.

Omitted autonomy keeps Factory's default (medium in the probed CLI); Factory policy determines which operations request approval. Explicit `--autonomy` accepts off, low, medium, or high. `--full-auto` sets high and permits runtime permission requests; AskUser remains interactive.

`askUserHandler` maps each indexed Factory question into `context.permission('AskUserQuestion', { questions }, signal)`. SessionHost publishes the question and waits for the invoking human. GroupChat displays option labels as suggestions; single-question replies accept an option label or custom free text. Multiple-question replies are JSON objects keyed by exact question text. Answers remain strings, not option IDs or arrays. Allowed `updatedInput.answers`, keyed by question text, become `{ answers: [{ index, question, answer }] }`. Denial/cancellation becomes `{ cancelled: true, answers: [] }`.

Core verifies TaskBar confirmations with verifier tool `droid.approval` and context server `agent-bridge`. Signed card, tool, canonical arguments, and active turn identity must match the pending operation.

## Scoped collaboration tools and identity

`createSdkMcpServer({ name: 'nia', version: '0.2.0', tools })` exposes `send_message` and `chat_history` using server-provided descriptions. The SDK hosts them on authenticated loopback HTTP; no bridge private key is passed to the child. Tool arguments cannot select another chat. `chat_history` is annotated read-only.

`send_message({ content })` calls `context.send`; `chat_history({ limit?, offset? })` calls `context.history`. Only explicit sends publish; assistant/result text remains private. Core publishes idle with the processed `deliveryId`.

Incoming raw senders use `messages[].authorId`; structured channels may expose `senderId`. Native mentions use `<mention userId="<userId>" />` with an ID from the received message/member list.
