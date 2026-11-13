# Nia Teams Agent Bridge v1 Specification

Wire-level contract between Nia Teams (`https://nia-teams.com`) and external Agent hosts implemented by `@nia-teams/claude-code-plugin` (`src/pairing.ts`, `src/bridge-client.ts`, `src/types.ts`, and `src/channel-server.ts`). `teamId`, `groupChatId`, and Nia `sessionId` are 24-character hex identifiers (`teamId` identifies the paired Agent).

## 1. Host Pairing & Ed25519 Challenge-Lease Authentication

### 1.1 HTTP Transport

The server URL is an HTTP(S) origin without credentials, path, query, or fragment. JSON POST requests use `Content-Type: application/json`; GET requests carry no body. HTTP redirects are rejected. Requests use a 15-second timeout combined with any caller `AbortSignal`; non-2xx responses raise `BridgeHttpError`.

### 1.2 Start & Browser Approval

The host generates an Ed25519 keypair (SPKI public PEM, PKCS#8 private PEM) and a 32-byte random `registrationNonce` encoded as unpadded `base64url`.

`POST /api/agent-bridge/pairing/start`:

```json
{
  "publicKey": "-----BEGIN PUBLIC KEY-----\n<SPKI base64>\n-----END PUBLIC KEY-----",
  "hostLabel": "claude-code@build-server",
  "registrationNonce": "<32 random bytes, base64url>"
}
```

Response:

```json
{
  "pairingId": "<opaque pairing reference>",
  "pairingCode": "A7F39C2B",
  "verificationUrl": "https://nia-teams.com/bridge/agent-pair/A7F39C2B"
}
```

The browser route `${origin}/bridge/agent-pair/${pairingCode}` creates and binds a new external Agent in one step (the signed-in creator becomes `owner`, and assigning an organization requires membership in that organization) or rebinds an existing external Agent administered by an `owner` or `admin`. Completing a rebind or unpairing on Nia Teams increments `keyGeneration`, and completing a rebind, unpairing, or archiving closes active connections with WebSocket close code `4401`; cloud native Agents are isolated and cannot be bound.

`GET /api/agent-bridge/pairing/status?reference=<URL-encoded pairingId>` returns `status` in `"pending" | "approved" | "paired" | "expired"`:

```json
{
  "status": "approved",
  "pairingId": "<opaque pairing reference>",
  "teamId": "65f000000000000000000002",
  "approvedByUserId": "65f000000000000000000001"
}
```

While `"pending"`, the client polls every 2s by default (`timeoutMs` defaults to `600000`). `"approved"` supplies the `teamId` and `approvedByUserId` bound in the registration signature; `"paired"` and `"expired"` reject.

### 1.3 Registration Proof & Completion

The host signs the UTF-8 bytes of the following LF-separated payload (no trailing newline) using raw Ed25519 (`crypto.sign(null, Buffer.from(payload, 'utf8'), privateKeyPem)`) and encodes the signature as standard `base64`:

```text
nia-agent-bridge-register-v1\n${pairingId}\n${teamId}\n${registrationNonce}\n${approvedByUserId}
```

`POST /api/agent-bridge/pairing/complete`:

```json
{
  "pairingReference": "<original pairingId>",
  "signature": "<Ed25519 signature, base64>"
}
```

Response:

```json
{
  "ok": true,
  "teamId": "65f000000000000000000002",
  "agentSlug": "claude-host",
  "agentName": "claude-host",
  "issuer": "https://nia-teams.com",
  "keyGeneration": 1
}
```

The client verifies `ok === true` and `completed.teamId === status.teamId` before persisting `credentials.json`.

### 1.4 Challenge & Single-Use Lease

On each WebSocket connection attempt, the host requests a challenge:

`POST /api/agent-bridge/challenge`:

```json
{ "teamId": "65f000000000000000000002" }
```

Response (`Challenge`):

```json
{
  "challengeId": "<opaque challenge ID>",
  "teamId": "65f000000000000000000002",
  "keyGeneration": 1,
  "nonce": "<server nonce>",
  "expiresInSeconds": 120
}
```

The client checks `teamId` and `keyGeneration` against `credentials.json`, then signs the UTF-8 bytes of the following LF-separated payload (no trailing newline, decimal `keyGeneration`, standard `base64` output):

```text
nia-agent-bridge-auth-v1\n${challengeId}\n${teamId}\n${keyGeneration}\n${nonce}
```

`POST /api/agent-bridge/lease`:

```json
{
  "teamId": "65f000000000000000000002",
  "challengeId": "<opaque challenge ID>",
  "signature": "<Ed25519 signature, base64>"
}
```

Response (`Lease`):

```json
{
  "lease": "<single-use opaque WebSocket lease>",
  "expiresInSeconds": 60,
  "gatewayUrl": "wss://nia-teams.com/ws/agent-bridge",
  "issuer": "https://nia-teams.com"
}
```

The client verifies `lease.issuer === credentials.issuer` and checks that `gatewayUrl` uses the paired origin's host, pathname `/ws/agent-bridge`, and matching scheme (`wss:` for `https:`, `ws:` for `http:`) without credentials, query, or fragment.

### 1.5 Host Credentials File (`credentials.json`)

Default directory precedence: explicit `configDir`, `NIA_CLAUDE_CONFIG_DIR`, `~/.config/nia-teams-claude-code`.

```json
{
  "serverUrl": "https://nia-teams.com",
  "teamId": "65f000000000000000000002",
  "agentSlug": "claude-host",
  "agentName": "claude-host",
  "issuer": "https://nia-teams.com",
  "keyGeneration": 1,
  "hostLabel": "claude-code@build-server",
  "publicKeyPem": "<Ed25519 SPKI PEM>",
  "privateKeyPem": "<Ed25519 PKCS#8 PEM>",
  "pairedAt": "2026-11-03T00:00:00.000Z"
}
```

`saveCredentials` and `loadCredentials` reject the filesystem root itself as `configDir`; for a path with more than one component, only an existing first component in the case-sensitive set `var`, `tmp`, `etc`, `home`, `Users`, `workspace` can be resolved as the base, and only when it is a non-symlink directory or a symlink with verifiable POSIX `lstat.uid === 0` whose `realpath` target is also a root-owned directory; otherwise traversal starts at the filesystem root, with every subsequent component checked using `lstat` and every symlink rejected. `HOME`/`TMPDIR` never define an exemption. `saveCredentials` creates missing segments individually, requires the requested directory itself to be a regular directory, sets its POSIX mode to `0700`, rejects an existing symlink or non-regular `credentials.json` before writing and immediately before atomic rename, and writes the temporary file exclusively with mode `0600`; `loadCredentials` applies the same path checks without creating or chmodding anything. These portable path checks do not replace OS-level isolation against concurrent directory replacement by an attacker with write access to an ancestor. `loadCredentials` checks `lstat(path).isFile()` (which rejects symlinks and non-regular files) and requires no POSIX group/other permission bits (`(mode & 0o077) === 0`), validates all fields, and verifies that `publicKeyPem` matches the public key derived from `privateKeyPem`.

## 2. WebSocket Transport (`/ws/agent-bridge`, `protocolVersion: 1`)

### 2.1 Handshake & Heartbeat

Immediately after opening `gatewayUrl`, the client sends:

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "teamId": "65f000000000000000000002",
  "lease": "<single-use lease>",
  "hostLabel": "claude-code@build-server"
}
```

First server frame (`ReadyFrame`):

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "connectionGeneration": "<opaque connection generation>",
  "agent": {
    "teamId": "65f000000000000000000002",
    "slug": "claude-host",
    "name": "claude-host",
    "orgName": "Acme"
  },
  "issuer": "https://nia-teams.com"
}
```

The client validates `protocolVersion === 1`, `agent.teamId === credentials.teamId`, `issuer === credentials.issuer`, and initializes the RS256 confirmation verifier with `${credentials.serverUrl}/oauth2/jwks`.

Frames are UTF-8 JSON text objects up to 512 KiB (`512 * 1024` bytes). Handshake and `ready` each enforce a 15s timeout. Once ready, the client sends a heartbeat every 20s and closes the socket if no valid version-1 frame arrives within 60s:

```json
{ "type": "heartbeat", "protocolVersion": 1, "at": 1793664000000 }
```

| Close code | Meaning | Client behavior |
| --- | --- | --- |
| `4400` | Invalid frame or protocol violation | Disconnect and reconnect with backoff |
| `4401` | Unauthorized, key rotated, or unpaired | Disconnect and reconnect with backoff |
| `4408` | Hello handshake timeout | Disconnect and reconnect with backoff |
| `4409` | Superseded by a newer host connection | Terminal `close()`; stop reconnecting |

Reconnect backoff starts at 1s and doubles up to a 30s base cap with jitter in `[0.75, 1.25)`, resetting upon `ready`.

### 2.2 Deterministic Thread Identity

```text
stableExternalAgentThreadId(groupChatId, teamId)
= "nia-gc-" + base64url(SHA256(UTF8(groupChatId + ":" + teamId))).slice(0, 24)
```

`agentThreadId` identifies the stable bridge thread for `(groupChatId, teamId)`. Nia `sessionId` identifies the current execution segment on Nia Teams; outbound RPCs and publication retries pass `sessionId`. Every inbound push frame must carry `agentThreadId === stableExternalAgentThreadId(groupChatId, teamId)`.

## 3. Server-to-Host Push Frames & Delivery Acknowledgment

All push frames share `PushBase`:

```ts
interface PushBase {
  protocolVersion: 1;
  deliveryId: string;
  groupChatId: string;   // 24-hex
  sessionId: string;     // 24-hex Nia session ID
  agentThreadId: string; // stableExternalAgentThreadId(groupChatId, teamId)
}
```

### 3.1 `thread.message`

```ts
interface ThreadMessage extends PushBase {
  type: 'thread.message';
  reason: 'message' | 'joined';
  groupChat: {
    title: string;
    url: string;
    members: Array<{
      kind: 'human' | 'agent'; id: string; name: string; orgName?: string;
    }>;
  };
  invokedBy?: { userId?: string; userName: string };
  triggerMessageId: string;
  messages: Array<{
    id: string;
    kind: 'human' | 'agent' | 'system';
    authorId?: string;
    authorName: string;
    replyToMessageId?: string;
    content: string;
    createdAt: string;
    attachments?: Array<{
      name: string; mimeType: string; size: number; url: string; transcript?: string;
    }>;
  }>;
}
```

### 3.2 `card.action`

```ts
interface CardAction extends PushBase {
  type: 'card.action';
  cardId: string; // starts with `agent_bridge:${teamId}:`
  decision: 'approved' | 'canceled';
  clickedBy: {
    userId: string; name: string; teamRole?: 'owner' | 'admin' | 'member';
  };
  _meta?: Record<string, unknown>; // carries nia/confirmationToken when decision === 'approved'
}
```

### 3.3 `thread.cancel`

```ts
interface ThreadCancel extends PushBase {
  type: 'thread.cancel';
  reason: 'user_aborted' | 'removed_from_group';
}
```

### 3.4 Delivery Acknowledgment & Deduplication

When all registered push handlers for an inbound frame resolve, the client sends:

```json
{
  "type": "ack",
  "protocolVersion": 1,
  "sessionId": "65f000000000000000000003",
  "deliveryId": "<deliveryId>"
}
```

If no handler is registered for that push type or a handler throws, no `ack` is sent. Accepted deliveries are deduplicated in an insertion-ordered cache of `(sessionId, deliveryId)` (default 2,000 entries); duplicate deliveries already accepted on the process re-send `ack` without re-running handlers.

## 4. Host-to-Server RPC

### 4.1 Request & Response Envelopes

Request (`rpc.request`, default 30s timeout):

```json
{
  "type": "rpc.request",
  "protocolVersion": 1,
  "requestId": "<UUID>",
  "method": "group_chat.history",
  "params": { "sessionId": "65f000000000000000000003", "limit": 50, "offset": 0 }
}
```

Success response (`rpc.response`):

```json
{
  "type": "rpc.response",
  "protocolVersion": 1,
  "requestId": "<same UUID>",
  "ok": true,
  "result": { "messages": [] }
}
```

Error response (`rpc.response`, raises `BridgeRpcError(code, message, retryable)`):

```json
{
  "type": "rpc.response",
  "protocolVersion": 1,
  "requestId": "<same UUID>",
  "ok": false,
  "error": { "code": "invalid_request", "message": "Invalid parameters", "retryable": false }
}
```

### 4.2 RPC Methods

| Method | Parameters (`params`) | Description |
| --- | --- | --- |
| `group_chat.send_message` | `sessionId`, `content: string`, `toolCallId: string` | Publish a message to the GroupChat (`toolCallId` provides server-side idempotency) |
| `group_chat.history` | `sessionId`, `limit: number` (`1..100`), `offset: number` (`>= 0`) | Read earlier GroupChat messages |
| `card.upsert` | `sessionId`, `toolCallId`, `cardId`, `title`, `subtitle`, `description?`, `actionLabel: "允许执行"`, `verifyToolName`, `verifyArguments` | Create or update a pending TaskBar confirmation card |
| `card.cancel` | `sessionId`, `cardId: string` | Cancel a pending TaskBar card |
| `thread.activity` | `sessionId`, `state: "executing" \| "waiting" \| "idle"`, `label?: string`, `errorMessage?: string` | Update live Agent activity status in the GroupChat |

Permission card identifiers use the namespace and request binding defined below.

- Permission relay uses `verifyToolName: "claude_code.permission"` and exact `verifyArguments` as defined in section 6.
- `cardId` uses namespace `agent_bridge:${teamId}:${agentThreadId}:perm:${request_id}:${randomUUID().slice(0, 8)}` (maximum 200 characters).

### 4.3 Publication Queue

The queue buffers explicitly published replies (random UUID `toolCallId`) across transient disconnects: FIFO, at most 256 entries / 16 MiB, rejected before admission if full. Individual frames including envelope overhead must fit 512 KiB. Ready events and 2-second transient-error retries flush the queue. Accepted content is not evicted. Send acknowledgments prevent resending content when only activity synchronization fails. A non-retryable RPC error rejects the entry. This is process-local, not durable storage.

## 5. TaskBar Confirmation Token (`_meta["nia/confirmationToken"]`)

### 5.1 Verification Rules

When a member clicks **允许执行** on a TaskBar card, Nia Teams verifies that the clicker is an active member (`owner`, `admin`, or `member`) of the external Agent, signs an RS256 confirmation JWT, and delivers `card.action` with `decision: "approved"`, `clickedBy: { userId, name, teamRole }`, and `_meta["nia/confirmationToken"]`.

The host verifies `_meta` via `verifyHumanActionContext(action._meta, { server: 'agent-bridge', tool: verifyToolName, arguments: verifyArguments, expectedCardId: cardId })` from `@nia-teams/mcp-sdk/auth`:

| Claim | Verification rule |
| --- | --- |
| `iss` | Matches paired `credentials.issuer` |
| `aud` | `"nia-teams-workload"` |
| `sub` | `"nia-teams-platform"` |
| `principal_type` | `"service"` |
| `human_confirmed` | `true` |
| `confirmed_by` | Non-blank 24-hex user ID of the confirming member |
| `confirmed_by_name` | Non-blank display name of the confirming member |
| `confirmation_card_id` | Matches pending `cardId` |
| `context_server` | `"agent-bridge"` |
| `context_tool` | `"claude_code.permission"` |
| `context_arguments_sha256` | `canonicalJsonSha256(verifyArguments)` |
| `iat`, `exp`, `jti` | `iat <= now < exp`, token lifetime and age `<= 300s`, non-blank `jti` |

### 5.2 Canonical JSON Digest (`canonicalJsonSha256`)

1. Primitives (`string`, `boolean`, `null`, finite `number`) serialize via `JSON.stringify` (`-0` serializes as `"0"`).
2. Dense arrays serialize in index order.
3. Plain objects serialize with own enumerable string keys sorted in UTF-16 code-unit order (`Array.prototype.sort()`) with no whitespace.
4. `undefined`, non-finite numbers, `bigint`, symbols, functions, class instances, sparse arrays, and circular references throw `TypeError`.

### 5.3 Approval Outcomes

Only a verified approved action allows the pending host request. Canceled or invalid confirmations deny it. Ordinary chat text never authorizes tools. The plugin does not infer approval from `clickedBy` role fields. Nia Teams enforces external Agent membership (`owner` / `admin` / `member`) before issuing confirmation tokens; these human roles are distinct from workload identity `sub`, organization scope, or `role:*` claims.

## 6. Claude Code Channel Mapping

Reference: [Anthropic Channels reference](https://code.claude.com/docs/en/channels-reference). These notification methods extend MCP; the TypeScript SDK provides transport and validation, not host policy. The implementation imports `z` from `zod` and registers an object schema with a literal `method` using `Server.setNotificationHandler`. SDK ^1.29 supports Zod ^3.25 / ^4 through its compatibility layer; the lockfile records the tested versions. No unsafe schema casts or mixed `zod/v3` / `zod/v4` imports are required.

### 6.1 Server Initialization

MCP implementation identity is `{ name: "nia-teams", version: "0.1.0" }`. Capabilities:

```json
{
  "tools": {},
  "experimental": {
    "claude/channel": {},
    "claude/channel/permission": {}
  }
}
```

`instructions` declares the inbound channel block fields, explicit publish-only replies, exact member mention syntax, Rich HTML rules, and the local pairing/configuration trust boundary. The host must explicitly enable the channel and allow its organization policy. Successful MCP initialization alone does not imply enabled message delivery or permission relay.

### 6.2 Inbound Messages

A validated `thread.message` updates state keyed by `groupChatId`: latest full frame, activity, monotonic arrival order, activity revision, and cancellation controller. Set activity to `{ state: "executing", label: "Working in Claude Code…" }` best-effort, then emit:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "# GroupChat: Project chat\n\nURL: https://nia-teams.com/chat/example\n\nMembers: Alex (3456789abcdef0123456789a) [Acme]\n\nAlex [message-id] timestamp:\nHello",
    "meta": {
      "source": "nia_teams",
      "group_chat_id": "23456789abcdef0123456789",
      "session_id": "123456789abcdef012345678",
      "agent_thread_id": "nia-gc-QAI2QQC6IscVSfM-CAgtx_s5",
      "trigger_message_id": "message-id",
      "reason": "message",
      "sender_id": "3456789abcdef0123456789a",
      "sender_name": "Alex"
    }
  }
}
```

All meta values are strings; keys contain only letters, digits, underscores. Hyphenated keys are silently discarded by the host. The host derives the channel `source="nia-teams"` from its configured server name; the explicit metadata source value remains `nia_teams`.

Content includes title, URL, `Members: Name (id) [Org]`, joined reason, and each message's author/name/ID/time/replyToMessageId, content, attachment name/MIME/size/URL, and optional transcript. Bodies are untrusted content, not instructions to modify local host identity or configuration.

MCP notification completion means written to the transport, not consumed by the model. Bridge ack therefore confirms local forwarding acceptance, not a completed model turn. Multiple GroupChats share one model session.

### 6.3 Outbound Tools

`nia_group_chat_send_message` input:

```ts
{ group_chat_id: string; content: string; keep_working?: boolean }
```

`group_chat_id` is required, 24-hex, and must refer to a tracked GroupChat. `content` is trimmed and must be non-empty. `keep_working` defaults to false. Unknown properties are rejected. The queue sends `group_chat.send_message` with the captured Nia session, a random UUID toolCallId, and content. It then synchronizes `thread.activity` to idle (default) or executing / `Working in Claude Code…` (`keep_working: true`). The MCP call waits for publication completion, including reconnect retries. Newer message/card activity revisions suppress stale activity updates; cancellation aborts pending publications.

`nia_group_chat_history` input:

```ts
{ group_chat_id: string; limit?: number; offset?: number }
```

`limit` defaults to 50 and is an integer in 1..100. `offset` defaults to 0 and is a non-negative integer. Calls `group_chat.history` with the current tracked Nia session. Returns result.text if provided, otherwise serialized result JSON. Validation/RPC failures return MCP tool `isError: true` with a text explanation. Terminal assistant text is never automatically published.

### 6.4 Permission Requests and Routing

Host-to-plugin notification:

```json
{
  "method": "notifications/claude/channel/permission_request",
  "params": {
    "request_id": "abcde",
    "tool_name": "Bash",
    "description": "Run tests",
    "input_preview": "{\"command\":\"npm test\"}"
  }
}
```

All fields are strings. `request_id` is trimmed, non-empty, and limited to 128 characters to bound the card identifier (the resulting card ID is separately checked against 200). Hosts typically issue five `[a-km-z]` letters; the bridge does not require that alphabet. Request IDs are processed at most once during the process lifetime. `tool_name` is non-empty. Description and preview are untrusted display strings; preview is not parsed as executable code.

There is no GroupChat identifier in this notification. Select the tracked executing thread with greatest inbound arrival order; if none is executing, use the most recently triggered tracked GroupChat. If none exists, log to stderr and skip card creation, leaving the local terminal approval untouched. Routing is a heuristic, not model-session isolation.

Capture `(groupChatId, sessionId, agentThreadId, cardId)` before awaiting any RPC. Create:

```ts
const verifyArguments = {
  agentThreadId,
  requestId: request_id,
  toolName: tool_name,
  description,
  inputPreview: input_preview,
};
// RPC method: card.upsert
{
  sessionId,
  toolCallId: `perm:${request_id}`,
  cardId: `agent_bridge:${teamId}:${agentThreadId}:perm:${request_id}:${uuidPrefix}`,
  title: `Allow ${tool_name}?`,
  subtitle: description || `Claude Code requested permission to run ${tool_name}.`,
  // description: input_preview, only when non-empty
  actionLabel: '允许执行',
  verifyToolName: 'claude_code.permission',
  verifyArguments,
}
```

`uuidPrefix` is the first eight characters of a random UUID. The request upsert has a 5-second local timeout; an uncertain upsert triggers best-effort cancellation and deny. A pending wait is registered before sending, so fast actions are not lost. Pending cards expire after five minutes, cancel remotely and deny. Activity becomes waiting / `等待确认` after upsert unless the wait already settled.

### 6.5 Card Verification and Verdicts

An action must match all four captured identity fields. A mismatched/unknown action is ignored. For approved actions:

```ts
await bridge.verifyCardApproval(action._meta, {
  server: 'agent-bridge',
  tool: 'claude_code.permission',
  arguments: verifyArguments,
  expectedCardId: cardId,
});
```

The signed `context_arguments_sha256` is the lowercase hex SHA-256 digest of UTF-8 canonical JSON for the exact five-field `verifyArguments` object above. `context_tool` must be `claude_code.permission`; section 5 defines the remaining RS256/JWT checks. After asynchronous verification, recheck that the same wait is still pending and not canceled before emitting allow.

Plugin-to-host verdict:

```json
{
  "method": "notifications/claude/channel/permission",
  "params": { "request_id": "abcde", "behavior": "allow" }
}
```

`behavior` is `allow` only after verification, otherwise `deny`. Canceled actions deny without requiring a token. Remove the wait and timer before emitting the verdict to prevent concurrent duplicate actions. Resume activity as executing / `Running <tool>…` on allow or `Thinking…` on deny, unless canceled or shutting down.

The local terminal and channel prompts race. The host applies the first response to an open request and ignores stale verdicts. There is no completion notification for terminal-winning prompts in this contract: a remote card can remain until its local timeout. No session-wide permission allowance is persisted. Project trust and MCP consent do not use this relay.

## 7. Cancellation and Process Lifetime

- `thread.cancel` must match the tracked GroupChat, session, and thread. Abort queued publications; cancel matching cards and emit deny. Set idle. A `removed_from_group` event deletes thread state; a `user_aborted` event emits a Channel notification with snake_case IDs, reason `user_aborted`, and text asking the model to stop the task.
- Channel notifications cannot forcibly interrupt a local tool. The shared host session and terminal operator retain control.
- A sessionId rotation aborts old queued publications and permissions before storing the new context.
- Executing/waiting threads refresh their activity every 30 seconds, and after bridge ready. Idle threads do not renew busy leases.
- Channel shutdown is idempotent: stop refresh, reject pending queue entries, unsubscribe push listeners, deny and cancel pending cards, idle busy threads, close bridge and MCP. Cleanup RPCs use short AbortSignals (1 second card cancellation, 1.5 seconds activity).
- The stdio CLI handles stdin end/close, SIGINT, SIGTERM, SIGHUP, MCP transport close, and a 1-second destroyed/readableEnded watchdog. A 2.5-second hard deadline closes the bridge and exits even when the stdio peer disappears during cleanup.
- Only StdioServerTransport writes stdout. Diagnostics are stderr-only. No lease, private key, or confirmation JWT is printed by the CLI.

## GroupChat sender identity and mentions

Incoming messages carry sender metadata, for example `[chat:<chatId>] Alice (<userId>): ...`, or `senderId` in structured channel payloads. This bridge's raw `thread.message` uses `messages[].authorId`; its formatted prompt lists `Alice (<userId>)` and member IDs. Use the received sender/member ID, not the display name.

To notify a member with a native Nia Teams highlight, emit `<mention userId="<userId>" />` in the published reply. Plain `@Name` is text, not a real mention. Do not invent IDs; consult the member list/history if needed.
