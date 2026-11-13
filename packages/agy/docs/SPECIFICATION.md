# Antigravity ACP adapter contract

Protocol evidence: user-supplied macOS captures from `agy 1.4.10` / `Antigravity ACP Server 1.5.4`. Agent Bridge transport, credential signing, and RS256 confirmation claims follow [core Agent Bridge v1](../../core/docs/SPECIFICATION.md). Example identifiers below are synthetic.

## 1. Process and JSON-RPC framing

Executable precedence: explicit `agyBin` / CLI `--agy-bin`, `AGY_BIN`, `agy` on PATH, `~/.local/bin/agy`, `~/.antigravity/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`.

```text
<agy> acp [--dangerously-skip-permissions] [--sandbox]
```

stdin/stdout carry newline-delimited JSON-RPC 2.0. stderr is diagnostic output. The client uses numeric monotonically increasing IDs; server request IDs may be strings or numbers. An inbound `method` denotes a server request/notification even if its ID matches a pending client request. Replies preserve the server ID's type. Unknown server requests receive `-32601`.

Client control requests default to 30 seconds; prompts default to 600 seconds. Constructor options `requestTimeoutMs` / `promptTimeoutMs` accept positive overrides. Timeout, malformed framing, oversized frames, or process exit reject all pending requests in that process generation. Raw frames are limited to 4 MiB; accumulated assistant text to 480 KiB. A later turn may start a new child; a failed prompt is not replayed.

## 2. Initialization

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"nia-agy","version":"0.1.0"}}}
```

The response must contain `result.protocolVersion === 1`. `agentCapabilities`, `agentInfo`, and `authMethods` describe upstream capabilities; authentication remains local to agy. No Codex-style `initialized` notification is added.

## 3. New and resumed sessions

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "session/new",
  "params": {
    "cwd": "/path/to/workspace",
    "mcpServers": [{
      "name": "nia-teams",
      "command": "<Node executable>",
      "args": ["<installed package>/dist/mcp-server.js"],
      "env": [
        {"name": "NIA_AGY_MCP_URL", "value": "http://127.0.0.1:<ephemeral-port>/tool"},
        {"name": "NIA_AGY_MCP_TOKEN", "value": "<ephemeral turn capability>"}
      ]
    }],
    "systemPromptAppend": "<core GROUP_CHAT_INSTRUCTIONS>"
  }
}
```

`mcpServers[].env` is an array of `{ name: string, value: string }`, not an environment object. The appended instructions include native `<mention userId="member-id" />` syntax and publication/tool rules. A new result must include a nonblank `sessionId`:

```json
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"00000000-0000-4000-8000-000000000001","models":{"availableModels":[],"currentModelId":"<upstream-model-id>"},"modes":{"currentModeId":"default","availableModes":[]}}}
```

A saved GroupChat mapping uses:

```json
{"jsonrpc":"2.0","id":3,"method":"session/resume","params":{"sessionId":"00000000-0000-4000-8000-000000000001","cwd":"/path/to/workspace","mcpServers":[{"name":"nia-teams","command":"<Node executable>","args":["<installed package>/dist/mcp-server.js"],"env":[{"name":"NIA_AGY_MCP_URL","value":"http://127.0.0.1:<ephemeral-port>/tool"},{"name":"NIA_AGY_MCP_TOKEN","value":"<fresh turn capability>"}]}]}}
```

An explicit JSON-RPC error from resume permits `session/new`; transport failure, timeout, malformed response, and returned identity mismatch do not. A successful resume may omit `sessionId`; if supplied it must equal the saved ID. The resulting ID is persisted by core `ThreadMapStore` through `context.session`, under `agentThreadId` with `groupChatId` and timestamp. No second durable mapping is maintained in this package.

Optional configuration follows session setup and precedes the prompt:

```json
{"jsonrpc":"2.0","id":4,"method":"session/set_mode","params":{"sessionId":"<sid>","modeId":"plan"}}
{"jsonrpc":"2.0","id":5,"method":"session/set_model","params":{"sessionId":"<sid>","modelId":"<available-model-id>"}}
```

Modes: `default`, `accept-edits`, `auto`, `plan`. `--full-auto` / `--bypass-approvals` adds the spawn flag `--dangerously-skip-permissions` and defaults an unspecified mode to `auto`; an explicit mode wins. Model names are taken from upstream account availability.

## 4. Prompt and stream

```json
{"jsonrpc":"2.0","id":6,"method":"session/prompt","params":{"sessionId":"<sid>","prompt":[{"type":"text","text":"<formatThreadMessage output>"}]}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<sid>","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}
{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn","usage":{"inputTokens":10,"outputTokens":1}}}
```

Only text `agent_message_chunk` deltas for the active session and child generation are concatenated. `thought_chunk` / `agent_thought_chunk` report thinking activity. `tool_call` / `tool_call_update` with `status: in_progress` report `Running <title || name>…`. Unknown/inactive session notifications are ignored. Only `end_turn` returns a final reply; other stop reasons fail the turn, and aborted turns never publish accumulated text.

Core SessionHost serializes turns within each GroupChat while the adapter multiplexes different ACP sessions over one child. A successful explicit scoped send suppresses duplicate publication of the final reply.

## 5. Server permission request

```json
{
  "jsonrpc":"2.0", "id":"1", "method":"session/request_permission",
  "params":{
    "sessionId":"<sid>",
    "toolCall":{"sessionUpdate":"tool_call","toolCallId":"call_example","name":"run_command","args":{"CommandLine":"echo HELLO_AGY"},"rawInput":{"CommandLine":"echo HELLO_AGY"},"status":"pending","kind":"execute","title":"echo HELLO_AGY"},
    "options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"deny","name":"Deny","kind":"reject_once"}]
  }
}
```

The adapter invokes actual core API `context.permission('agy:<tool-name>', { sessionId, toolCall, options })`. Prefixing the tool name prevents an ACP tool from impersonating core's `AskUserQuestion` path. SessionHost adds `agentThreadId`, turn ID, and tool/input to `verifyArguments` and requests a TaskBar card with verifier tool `agy.approval`, server `agent-bridge`.

Approval requires core `verifyCardApproval` to validate RS256 signature via `${issuer}/oauth2/jwks`, issuer, audience `nia-teams-workload`, service principal, human confirmation, lifetime, card ID, context tool, and canonical JSON argument SHA-256 digest. GroupChat membership alone is not Agent approval membership.

```json
{"jsonrpc":"2.0","id":"1","result":{"outcome":{"outcome":"selected","optionId":"allow"}}}
{"jsonrpc":"2.0","id":"1","result":{"outcome":{"outcome":"selected","optionId":"deny"}}}
{"jsonrpc":"2.0","id":"1","result":{"outcome":{"outcome":"cancelled"}}}
```

Use `allow_once` on verified approval and `reject_once` on denial. For entries without a kind, exact IDs `allow` / `deny` are accepted. Never upgrade a one-shot verdict to `allow_always`. Missing safe options return cancelled. Unknown/inactive sessions cannot be approved, including full-auto. Abort, dismissal, expiry, or invalid signatures deny. A result only applies while its original turn remains active in the same child generation.

## 6. Scoped MCP transport

The bundled `dist/mcp-server.js` uses `@modelcontextprotocol/sdk` stdio transport with two tools:

| Tool | Arguments | Host operation |
| --- | --- | --- |
| `nia_group_chat_send_message` | `{ content: nonblank string }` | `context.send(content)` |
| `nia_group_chat_history` | `{ limit?: 1..100, offset?: integer >= 0 }` | `context.history(limit, offset)`; defaults 50 / 0 |

The daemon binds one ephemeral HTTP relay to `127.0.0.1`. Each turn receives a random 256-bit capability; its helper only accesses that host-supplied context, never a model-selected chat/session. Revocation occurs when the turn finishes or aborts. Unknown tools, extra destination fields, invalid pagination, wrong tokens, and stale/aborted contexts fail. Bridge credentials and private keys are not sent to helpers. The URL and token are local process environment, not persistent state. Helpers restrict endpoints to loopback HTTP `/tool` and reject redirects.

## 7. Cancellation and process ownership

```json
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<sid>"}}
```

Abort sends a notification without awaiting a separate reply. If the in-flight request does not settle within 2 seconds, terminate that child (SIGTERM, then SIGKILL after 500 ms if needed). Other active turns in that child fail rather than being replayed. Later turns initialize a new generation and resume saved sessions where supported. Adapter close reaps owned children and closes the MCP relay. CLI uses core `runSessionDaemon` and always awaits runner close in finally.
