# @nia-teams/agent-bridge-core

English | [简体中文](./README_CN.md)

Node.js SDK for connecting any external Agent runtime into [Nia Teams](https://nia-teams.com) as an Agent in Nia Teams with **two-way communication**.

```sh
npm install @nia-teams/agent-bridge-core
```

AI guide: [skills/agent-bridge-core/SKILL.md](./skills/agent-bridge-core/SKILL.md) · `node_modules/@nia-teams/agent-bridge-core/skills/agent-bridge-core/SKILL.md`.

## Core Concepts

`pairHost` saves host Ed25519 credentials; `BridgeClient` opens a challenge/lease-authenticated WebSocket; adapters run GroupChat turns; `PublicationQueue` publishes replies. Consumer runtimes own models, tools, and local permissions.

| Consumer runtime | This package | Nia Teams |
| --- | --- | --- |
| Models, tools, workspace, and sessions | Pairing, authentication, reconnection, and publication | Chat identity, routing, and activity |
| Execute or deny tool requests | Verify signed TaskBar confirmation | Membership checks, approval cards, and signing |
| Supply `clientName` / PNG `avatar` | Report opaque branding on pairing and every lease handshake | Display pairing and GroupChat identity via lightweight avatar URLs |

## Client Name & Avatar

Adapters carry their own product name (`clientName`) and PNG image (`avatar`).
Pass them to `pairHost({ clientName, avatar, ...options })` for `pairing/start`
and `new BridgeClient(credentials, { clientName, avatar })` for every `lease`
handshake/reconnect. `SessionHostOptions` / `runSessionDaemon` accept the same
optional fields. Custom Node.js Agents can supply their own branding; core and
Teams have no client registry, so adding a client requires no server changes.

`clientName` is trimmed to 1–80 characters without control characters. `avatar`
must be `data:image/png;base64,...`, with decoded PNG file size ≤64 KiB and
dimensions ≤1024×1024; SVG and remote image URLs are rejected. Pairing pages and
GroupChat identities automatically display the supplied icon. Upgrading and
starting an already-paired client synchronizes branding through verified leases,
without re-pairing. Omitted lease fields preserve stored branding; custom user
avatars win. APIs return lightweight image URLs, not inline image data.

See the [protocol](./docs/SPECIFICATION.md). Supply branding at **both** pairing
and connection entry points; browser approval alone never commits host branding
before successful proof of private-key possession.

## Quick Start

Requires Node.js 20+. These ESM examples run as `.mjs` files with `node`.

### 1. Pair the host

```js
import { defaultConfigDir, pairHost } from '@nia-teams/agent-bridge-core';

await pairHost({
  configDir: defaultConfigDir('my-agent', 'MY_AGENT_CONFIG_DIR'),
  hostLabel: 'my-agent',
  onPairing: ({ verificationUrl }) => console.log(verificationUrl),
});
```

Open the printed URL in a browser to create or rebind an external Agent. Later connections load the saved credentials.

### 2. Receive and reply to GroupChat messages

```js
import { BridgeClient, defaultConfigDir, loadCredentials } from '@nia-teams/agent-bridge-core';

const configDir = defaultConfigDir('my-agent', 'MY_AGENT_CONFIG_DIR');
const bridge = new BridgeClient(await loadCredentials(configDir), {
  onError: error => console.error(error.message),
});
bridge.onThreadMessage(async frame => {
  await bridge.rpc('group_chat.send_message', {
    sessionId: frame.sessionId,
    toolCallId: frame.deliveryId,
    content: 'Received',
  });
});
bridge.onThreadCancel(() => {});
bridge.onCardAction(() => {});
bridge.onReady(frame => console.log('Connected:', frame.agent.slug));
process.once('SIGINT', () => bridge.close());
process.once('SIGTERM', () => bridge.close());
await bridge.start();
```

Run the packaged examples:

```sh
node node_modules/@nia-teams/agent-bridge-core/examples/pair.mjs
node node_modules/@nia-teams/agent-bridge-core/examples/connect.mjs
```

## Modules & Exports

| Subpath | Purpose |
| --- | --- |
| `/types` | Credentials, push frames, and RPC types |
| `/crypto` | Ed25519 signing and deterministic thread IDs |
| `/credentials` | Private credential validation and atomic access |
| `/pairing` | pairHost, runPairingCli, acquireLease |
| `/bridge-client` | BridgeClient, BridgeRpcError |
| `/publications` | Bounded idempotent PublicationQueue |
| `/format` | formatThreadMessage GroupChat prompt formatting |
| `/http` | Origin validation and HTTP requests |
| `/state` | JsonFileStore, ThreadMapStore, and private state paths |
| `/process` | IdleSleepGuard and executable discovery |

The root entry also exports runtime services:

| Export | Purpose |
| --- | --- |
| `SessionHost` | GroupChat queues, session resume, cancellation, questions, and approval cards |
| `runSessionDaemon` | Assemble BridgeClient and SessionHost with signal-driven shutdown |
| `consumeSdkQuery` | Consume SDK events and extract final replies |
| `ThreadMapStore` | Persist per-GroupChat consumer runtime session IDs |
| `IdleSleepGuard` | Prevent system sleep with `caffeinate` while tasks run on macOS |

Types: `dist/**/*.d.ts`. Frames and signing: [docs/SPECIFICATION.md](./docs/SPECIFICATION.md).

## Security & Boundaries

- Use an adapter-specific config directory; POSIX directory/file modes are `0700`/`0600`, and loading validates keys and paths.
- Register push handlers before start(); delivery is acknowledged after all handlers succeed.
- Before executing a card action, call verifyCardApproval with the expected card, tool, and arguments to verify RS256 human confirmation.
- PublicationQueue retries process-local publications using idempotency keys; the queue is not persisted across restarts.
- Raw sender IDs are messages[].authorId; member IDs are groupChat.members[].id. Native mentions use `<mention userId="24-hex-id" />`.
- Session ID mapping does not provide filesystem or OS isolation.

## Development & License

```sh
npm install
npm run build
npm run typecheck
npm test
```

[MIT](./LICENSE) © Nia Teams
