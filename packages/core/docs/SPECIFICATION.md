# Nia Teams Agent Bridge v1 Specification

Wire-level contract between Nia Teams (`https://nia-teams.com`) and external Agent hosts implemented by `@nia-teams/agent-bridge-core` (`src/pairing.ts`, `src/bridge-client.ts`, and `src/types.ts`). `teamId`, `groupChatId`, and Nia `sessionId` are 24-character hex identifiers (`teamId` identifies the paired Agent).

## 1. Host Pairing & Ed25519 Challenge-Lease Authentication

### 1.1 HTTP Transport

The server URL is an HTTP(S) origin without credentials, path, query, or fragment. JSON POST requests use `Content-Type: application/json`; GET requests carry no body. HTTP redirects are rejected. Requests use a 15-second timeout combined with any caller `AbortSignal`; non-2xx responses raise `BridgeHttpError`.

### 1.2 Start & Browser Approval

The host generates an Ed25519 keypair (SPKI public PEM, PKCS#8 private PEM) and a 32-byte random `registrationNonce` encoded as unpadded `base64url`.

`POST /api/agent-bridge/pairing/start`:

```json
{
  "publicKey": "-----BEGIN PUBLIC KEY-----\n<SPKI base64>\n-----END PUBLIC KEY-----",
  "hostLabel": "custom-agent@build-server",
  "registrationNonce": "<32 random bytes, base64url>",
  "clientName": "My Agent Runtime",
  "avatar": "data:image/png;base64,<PNG bytes encoded as standard base64>"
}
```

`clientName` and `avatar` are optional, client-owned branding metadata, not provider
identifiers. `clientName` is trimmed to 1–80 characters and must not contain control
characters. `avatar` must be a canonical `data:image/png;base64,...` URL: decoded
PNG file size **≤64 KiB (65,536 bytes)** and dimensions **≤1024×1024 pixels**.
The size limit applies to decoded PNG bytes, not the longer base64 string. The
server validates PNG headers and pixel decoding; SVG, other image formats, remote
URLs, malformed base64, and oversized images are rejected with HTTP 400. Omission
is supported for older clients. `avatarDataUrl` and `avatarUrl` are server input
aliases for the same PNG-only value; SDK clients send the canonical `avatar` field.

Adapters own their product name and image; core transports the values without a
client enum or server-side brand registry. Custom Node.js Agents can supply their
own values through `pairHost({ clientName, avatar, ...options })`.

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
  "agentSlug": "custom-agent",
  "agentName": "custom-agent",
  "issuer": "https://nia-teams.com",
  "keyGeneration": 1
}
```

Browser approval records human consent only: it does **not** replace an existing
host's branding. Only successful registration signature verification in
`pairing/complete` commits `clientName`, `avatar`, and the derived `avatarHash` with
the host key rotation. Failed proof leaves the previous host's branding intact.
A completed rebind replaces the previous host metadata, including removing branding
when the replacement client did not supply it. User-customized Agent avatars win.

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
  "signature": "<Ed25519 signature, base64>",
  "clientName": "My Agent Runtime",
  "avatar": "data:image/png;base64,<PNG bytes encoded as standard base64>"
}
```

The optional `clientName` and `avatar` follow the same validation contract as
`pairing/start`. `BridgeClient(credentials, { clientName, avatar })` reports the
installed client's branding on **every connection attempt and reconnect** via
this lease request; `runSessionDaemon` forwards the same `SessionHostOptions`
fields. Direct callers can use `acquireLease(credentials, signal, { clientName, avatar })`.
The `/challenge` body remains `{ teamId }`; the v1 signing payload above is unchanged
and does not include branding metadata.

Only after verifying the challenge signature and atomically consuming the challenge
does the server synchronize changed metadata to the paired host. Identical values
avoid redundant writes; omitted lease fields leave stored branding unchanged.
Thus an already-paired host updates its icon after upgrading and starting its
client, **without re-pairing**. Invalid supplied metadata fails with HTTP 400;
an invalid signature cannot update metadata.

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

#### Branding display and avatar delivery

The authenticated `GET /api/agent-bridge/pairing/context?reference=<code>` response
includes `clientName` (or `null`) and a lightweight `avatarUrl`. Pairing pages use
these for image source and alt text; Agent identity projections use the host avatar
URL for GroupChat members and other identity surfaces. Image data is stored once,
not repeated inline in context/member/message JSON.

- `GET /api/agent-bridge/pairing/:code/avatar.png`: supplied PNG or neutral fallback;
  `Cache-Control: private, no-store`, including expired-code responses (404).
- `GET /api/agent-bridge/host-avatar/:teamId.png?v=<avatarHash>`: a validated stored
  PNG with `Content-Type: image/png` and `X-Content-Type-Options: nosniff`. The current
  12-character SHA-256 hash enables `public, max-age=31536000, immutable`; stale hashes
  return 404/no-store. Unversioned requests and fallback images are not immutable.
- `GET /api/agent-bridge/default-avatar.png`: neutral fallback for clients that omit
  branding. User-customized Agent avatars take precedence over host branding.

### 1.5 Host Credentials File (`credentials.json`)

Core defaults to `~/.config/nia-teams-agent-bridge`; an explicit `configDir` overrides it. Adapters select their own directory and optional environment variable with `defaultConfigDir(dirName, envVar)`. Core does not implicitly read any adapter-specific environment variable.

```json
{
  "serverUrl": "https://nia-teams.com",
  "teamId": "65f000000000000000000002",
  "agentSlug": "custom-agent",
  "agentName": "custom-agent",
  "issuer": "https://nia-teams.com",
  "keyGeneration": 1,
  "hostLabel": "custom-agent@build-server",
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
  "hostLabel": "custom-agent@build-server"
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
    "slug": "custom-agent",
    "name": "custom-agent",
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

## GroupChat sender identity and mentions

Incoming messages carry sender metadata, for example `[chat:<chatId>] Alice (<userId>): ...`, or `senderId` in structured channel payloads. This bridge's raw `thread.message` uses `messages[].authorId`; its formatted prompt lists `Alice (<userId>)` and member IDs. Use the received sender/member ID, not the display name.

To notify a member with a native Nia Teams highlight, emit `<mention userId="<userId>" />` in the published reply. Plain `@Name` is text, not a real mention. Do not invent IDs; consult the member list/history if needed.

## Invite-code registration and group creation

`inviteCode` is `raw.trim().toUpperCase()` and must match `/^[A-Z0-9_-]{4,64}$/`. First registration requires `userName` and `agentName`, each normalized with `raw.replace(/\s+/g, ' ').trim()` and of length 1–60 (JavaScript string length). The host generates an Ed25519 keypair and `registrationNonce = randomBytes(32).toString('base64url')`.

The UTF-8 signature input has no trailing newline:

```text
nia-agent-bridge-invite-v1
<inviteCode>
<userName>
<agentName>
<registrationNonce>
```

`POST /api/agent-bridge/pairing/invite` accepts `{ inviteCode, userName, agentName, publicKey, registrationNonce, signature, hostLabel, clientName?, avatar? }`. `publicKey` is SPKI PEM; `signature` is an Ed25519 signature encoded as base64. `hostLabel` defaults to `<hostPrefix or agent-bridge>@<hostname>`; branding follows section 1.2.

Success returns `{ ok: true, userId, teamId, agentSlug, agentName, issuer, keyGeneration, groupChatId, handoffUrl }`. Credentials retain the locally generated keypair and are saved in a `0700` directory with file mode `0600`.

For existing same-server credentials, the host requests `POST /api/agent-bridge/challenge` with `{ teamId }`, verifies `teamId` and `keyGeneration`, and signs the challenge using section 1.4. It then sends `POST /api/agent-bridge/invite-group-chat` with `{ teamId, challengeId, signature, inviteCode }`. Success returns `{ ok: true, userId, teamId, agentSlug, agentName, groupChatId, handoffUrl }`; stored credentials remain unchanged. Challenge failures (including 404) or changed key generations require explicit re-pairing. Names do not authorize replacement registration. An explicitly different server URL selects first registration.

`connectWithInvite` returns `{ mode: 'paired' | 'reused', credentials, userId, groupChatId, handoffUrl, browserOpened }`. `openBrowser: false` disables browser launch. `NIA_NO_BROWSER` suppresses connection browser launch; `openBrowser` itself honors `NIA_NO_BROWSER=1`. Browser commands use argument arrays without a shell: `open` on macOS, `rundll32.exe url.dll,FileProtocolHandler` on Windows, and `xdg-open` elsewhere. Only HTTP(S) URLs are accepted; spawn failures return `false`. `browserOpened` means the opener spawned, not that a page finished loading.

Invite handoff URLs must be absolute HTTP(S) URLs without a username or password. HTTPS server origins require HTTPS handoff URLs. The handoff host and port may differ from the request origin (for example, a configured public base URL behind a reverse proxy). Validation applies before saving new credentials, returning the result, or opening a browser, including when browser launch is disabled.
