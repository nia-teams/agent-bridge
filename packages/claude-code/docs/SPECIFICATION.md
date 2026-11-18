# Claude Code SDK daemon runtime contract

The adapter supplies a Claude Code runner to core `SessionHost`. Pairing, credentials, signing, WebSocket delivery, state, confirmation verification, and publication retries follow [core Agent Bridge v3](../../core/docs/SPECIFICATION.md).

## SDK and executable contract

Inspected npm `@anthropic-ai/claude-agent-sdk@0.3.319`; package metadata is retained in `upstream/`. SDK archive SHA256:

```text
6bfb9ccb6a5d15686f5c7dd12d7a7da6d7b486ca6e1331ac8a7ab98a2d302001
```

`createClaudeRunner({ cwd, model?, fullAuto?, claudeBin? })` calls `query({ prompt, options })`. Executable discovery searches `claude` on PATH and common installation paths; `claudeBin` or `CLAUDE_BIN` selects an explicit path. A locally authenticated Claude Code CLI is required; Nia Teams pairing does not provide model authentication.

- `pathToClaudeCodeExecutable` selects the CLI; `cwd`, `model`, `resume`, and `abortController` configure each query.
- The SDK launches stream-json input/output with `--verbose`, `--permission-prompt-tool=stdio`, and `--resume=<sessionId>` for resumed queries. Initialize negotiates SDK tool servers and manifests.
- The SDK recognizes `.js` / `.mjs` entries. For Windows `.cmd` / `.bat` wrappers and `.cjs` entries, the adapter supplies `spawnClaudeCodeProcess`, using core `executableCommand` and Node `spawn` with piped stdio. Prompts stay on SDK stdin, not shell command lines.
- `settingSources: ['user', 'project', 'local']` retains local settings. `systemPrompt: { type: 'preset', preset: 'claude_code', append: context.systemPrompt }` preserves the Claude Code preset and adds server collaboration instructions.
- `strictMcpConfig: true` loads only the supplied scoped `nia` tool server. A low-level MCP `Server` serves every `ready.tools` entry with its raw JSON Schema. The SDK connects its `instance` through `.connect(transport)`. Tools without `deferLoading: true` carry `_meta: { "anthropic/alwaysLoad": true }`; deferred entries omit that metadata and use Claude Code native ToolSearch, including its model-dependent full-loading behavior. No custom search or meta-tool is registered. Calls delegate to `context.callTool` and the unified `tool.call` RPC; MCP text uses `result.content` verbatim and preserves `isError`.
- `permissionMode` is `default`; `fullAuto` selects `bypassPermissions` and `allowDangerouslySkipPermissions: true`. Existing allow rules and hooks may resolve requests before the SDK callback.

## Sessions, publications, and cancellation

`SessionHost` persists each GroupChat's SDK `session_id` in private `threads.json` and supplies it as `resume` on later turns. Credentials live separately in `credentials.json`. Chats have separate model contexts but share the workspace and local tools. Core serializes turns within a chat and queues incoming messages; session rotation aborts the old query and clears old inputs.

SDK system, assistant, and result events update session state and activity. Success has `type: "result"`, `subtype: "success"`, and `result: string`; errors carry `is_error` and `errors`. Subagent assistant messages and result text are not published as GroupChat replies. Every reply uses explicit `send_message({ content })`; `chat_history({ limit?, offset? })` reads the active chat. The host supplies destination and session context.

Cancellation aborts the SDK query and pending permissions. The runner removes its abort listener and closes the in-process tool server in `finally`. Core owns publication retries, atomic state persistence, connection recovery, and macOS sleep prevention. Idle activity identifies the processed delivery; server prompts own reminders for turns without a publication.

## Questions and signed TaskBar permissions

`canUseTool(name, input, detail)` returns `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`. All `mcp__nia__` collaboration tools bypass local approval because Nia Teams owns their ACLs and human-confirmation cards; other tool requests call the active `SessionHost` permission handler.

`AskUserQuestion` posts questions to GroupChat and waits for the invoking human. A single question accepts text; multiple questions accept a JSON object keyed by question text. Answers return in `updatedInput.answers`. Timeout or cancellation denies the request.

Other tool requests open signed TaskBar cards using tool `claude_code.permission` and server `agent-bridge`. Core verifies RS256 using `${issuer}/oauth2/jwks`, issuer, audience `nia-teams-workload`, lifetime, service identity, and `human_confirmed: true`. It matches `context_server`, `context_tool`, canonical-JSON argument SHA-256 digest, and `confirmation_card_id` to the locally pending card and turn. Missing/invalid tokens, dismissal, expiry, and cancellation deny the request. Chat text is not approval. Nia Teams checks the clicker's active Agent membership (`owner`, `admin`, or `member`) before signing.

## GroupChat sender identity and mentions

Incoming prompts include chat title, URL, members, sender IDs, messages, reply references, and attachment transcripts. Raw `thread.message` frames use `messages[].authorId`; formatted prompts list `Alice (<userId>)` and member IDs. Generic headers may use `[chat:<chatId>] Alice (<userId>): ...`; structured message payloads may expose `senderId`.

Publish `<mention userId="<userId>" />` using a received sender/member ID for a native Nia Teams notification. Plain `@Name` is text, not a native mention.
