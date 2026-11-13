# Agent Bridge protocol map

The shared transport contract is [core Agent Bridge v1](../packages/core/docs/SPECIFICATION.md). It defines Ed25519 pairing, challenge/lease authentication, WebSocket frames, publication RPCs and signed TaskBar confirmation verification. The repository has six client adapter packages plus the shared core (seven packages total). Adapter documents describe only their additional runtime contracts:

| Adapter | Runtime contract |
| --- | --- |
| Codex | [JSON-RPC app-server, persistent threads, approvals](../packages/codex/docs/SPECIFICATION.md) |
| Claude Code | [Channel protocol](../packages/claude-code/docs/SPECIFICATION.md) and [SDK daemon](../packages/claude-code/docs/DAEMON.md) |
| WorkBuddy | [SDK and desktop auth](../packages/workbuddy/docs/SPECIFICATION.md) |
| Doubao | [Desktop CDP, HTTP runtime and official CLI](../packages/doubao/docs/SPECIFICATION.md) |
| DSH | [Harness host protocol](../packages/dsh/docs/SPECIFICATION.md) |
| Antigravity | [ACP stdio sessions, streaming, permissions, scoped MCP](../packages/agy/docs/SPECIFICATION.md) |

## Client-owned branding: pairing and authenticated lease

The canonical [core protocol](../packages/core/docs/SPECIFICATION.md#12-start--browser-approval)
defines optional `clientName` and `avatar` fields on both
`POST /api/agent-bridge/pairing/start` and `POST /api/agent-bridge/lease`:

| Field | Contract |
| --- | --- |
| `clientName` | Product display name, trimmed to 1–80 characters; no control characters |
| `avatar` | Canonical `data:image/png;base64,...`; decoded PNG file ≤64 KiB (65,536 bytes), dimensions ≤1024×1024; no SVG or remote URL |

Each adapter owns its name and PNG. `pairHost` sends them during pairing;
`BridgeClient` sends them in every lease handshake/reconnect. Custom Node.js Agents
may supply their own values; adding a client does not require a server enum or
brand icon change. Invalid supplied values fail with 400; omitted values support
older clients. Branding is committed only after successful proof of possession,
not at browser approval. Authenticated lease updates synchronize changed branding
without re-pairing; omitted lease fields preserve existing metadata.

Pairing pages and GroupChat identity projections display the supplied icon using
lightweight image URLs rather than inline base64 JSON. Pairing image responses are
`private, no-store`; versioned host images use a content hash and immutable caching.
Custom user avatars take precedence. See the
[full authentication and image-delivery contract](../packages/core/docs/SPECIFICATION.md#14-challenge--single-use-lease)
and [adapter-owned asset sources](./AVATAR-SOURCES.md).

## GroupChat sender identity and mentions

Incoming messages carry sender metadata, for example `[chat:<chatId>] Alice (<userId>): ...`, or `senderId` in structured channel payloads. This bridge's raw `thread.message` uses `messages[].authorId`; its formatted prompt lists `Alice (<userId>)` and member IDs. Use the received sender/member ID, not the display name.

To notify a member with a native Nia Teams highlight, emit `<mention userId="<userId>" />` in the published reply. Plain `@Name` is text, not a real mention. Do not invent IDs; consult the member list/history if needed.

## Identity and safety invariants

`teamId` is the paired external Agent; `groupChatId` identifies the chat; `sessionId` is the current Nia Teams execution segment; `agentThreadId` is deterministic per chat and paired Agent. These are not local runtime thread IDs. All example hex IDs in specifications and tests are synthetic fixtures.

One host owns each credential directory. Tool permission requires a verified signed card action bound to the expected card, tool and canonical arguments. Sender metadata, message bodies and plain text approvals cannot authorize tools. Per-chat context isolation does not isolate filesystem or OS access. Publication queues are process-local.
