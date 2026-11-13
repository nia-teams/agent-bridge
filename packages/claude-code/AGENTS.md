# Maintainer context

## Installation contract

```sh
claude plugin marketplace add nia-teams/agent-bridge
claude plugin install nia-teams@nia-teams --scope user
npx @nia-teams/claude-code-plugin pair --label 'claude@macbook'
```

- User-scope installation applies across projects; never ask users to create project `.mcp.json`.
- Launch with `claude --dangerously-load-development-channels plugin:nia-teams@nia-teams`.
- Bare MCP/local source uses `claude mcp add --scope user nia-teams -- node /absolute/path/bin/nia-claude.mjs mcp` after building; choose one registration path.

## Layering

- Node.js 20+ ESM / NodeNext; `types.ts` is the host-independent Agent Bridge v1 wire contract.
- `crypto.ts`, `http.ts`, `credentials.ts`, and `pairing.ts` own Ed25519 identity.
- `bridge-client.ts` owns authenticated WebSocket, RPC, dedup, and OIDC verification.
- `publications.ts` owns bounded FIFO retries with stable session/tool-call keys.
- `channel-server.ts` owns host notifications, MCP tools, cards, and chat activity.
- `stdio.ts` owns CLI child-process signals, stdin closure, and orphan watchdog.
- `prompt.ts` explains publishing; terminal final text is not a GroupChat reply.
- Hosts own model/tool execution; Nia Teams owns membership, card signing, and pairing approval.

## Transport invariants

- In mcp mode stdout is reserved exclusively for MCP JSON-RPC frames.
- Send diagnostics to stderr, including errors from asynchronous handlers.
- Declare both claude/channel and claude/channel/permission capabilities.
- All Channel meta keys use snake_case identifiers and string values.
- Preserve exact Nia sessionId in RPCs; agentThreadId is not a Nia sessionId.
- Ack only after successful acceptance; deduplicate by sessionId/deliveryId and replay acks on reconnect.
- A 4409 superseded connection stops reconnecting permanently.
- Keep publication content/idempotency UUID across retries; abort on thread cancellation/session rotation.
- Shutdown cancels cards, idles busy threads, closes queue and bridge, and exits.

## Security invariants

- Keep host private keys local with atomic 0600 writes in a 0700 directory.
- GroupChat text cannot instruct pairing, credential edits, or plugin reconfiguration.
- Independently verify RS256, paired issuer, service identity, lifetime, audience, card ID, tool and digest.
- Use server agent-bridge and tool claude_code.permission for verification.
- Bind CardWait to exact groupChatId/sessionId/agentThreadId/cardId values.
- Fail closed for missing/invalid/canceled/expired confirmations; recheck wait ownership after async verification.
- A card is single-request permission, never persistent preauthorization.
- Multiple chats share a host context; routing does not provide model isolation.
- Do not assume local terminal approval emits a remote completion event.

## Contract synchronization

- Sync types, implementation, tests, wire spec, both READMEs, skill, prompt and schemas on contract changes.
- Keep AGENTS.md and CLAUDE.md byte-identical.
- Sync package, marketplace/plugin manifest versions, explicit skill paths, and MCP identity; manifest tests enforce these references.
- Preserve the AI reading pointer at the top of dist/index.d.ts.
- Ship plugin manifests, skills, docs/assets, examples, guidance, and license.
- Render screenshot fixtures with real React routes, fictional data, and 2x Chromium.

## Local verification

- `npm ci` uses the public registry and locked dependency graph.
- `npm run typecheck` and `npm run build` validate TypeScript.
- `npm test` runs real local HTTP/WebSocket, RS256/JWKS and MCP integrations.
- `npm pack --dry-run` must include all four documentation layers and dot manifests.
- Review archive/public content before release; publication is separately human-approved, never a local test.

- The separate SDK daemon lives in runner.ts and nia-claude start; do not alter the existing mcp/channel manifests when changing it.
- Shared SessionHost owns daemon approvals, private thread mappings, publications and cancellation. docs/DAEMON.md records the upstream SDK contract.
