# AGENTS.md

Repository context for AI coding agents maintaining `@nia-teams/dsh-plugin`.

- Configuring or embedding this package in a DeepSeek Harness host: read `skills/nia-teams-dsh/SKILL.md`.
- Wire-level Agent Bridge v1 HTTP/WebSocket frames, Ed25519 challenge signatures, and `nia/confirmationToken` claims: read `docs/SPECIFICATION.md`.

## Scope & Layering

`@nia-teams/dsh-plugin` bridges a DeepSeek Harness 0.2.x host to Nia Teams.
`@deepseek-ai/cordis` supplies the plugin lifecycle; the host supplies `agents`,
optional `tools`, `agentPresets`, and `agentDefaultModel` services. Model providers,
workspace execution, and session persistence remain host responsibilities.

- `src/pairing.ts` and `src/credentials.ts`: Ed25519 pairing, challenge/lease acquisition, private host credentials.
- `src/bridge-client.ts`: authenticated WebSocket, delivery acknowledgment/deduplication, RPC, confirmation verification.
- `src/plugin.ts`: owned GroupChat Agents, session resumption, activity leases, tool/approval/question interception, disposal.
- `src/publications.ts`: bounded, process-local FIFO publication retries with stable idempotency keys.
- `src/questions.ts`: numbered human question formatting and complete-batch reply parsing.
- `src/prompt.ts`: runtime mention and Rich HTML guidance injected through `system-prompt/assemble`.

## Invariants

- **Cordis named exports**: `src/index.ts` exports `name`, `inject`, `Config`, and `apply`
  with **no `default` export**. A default export hides `inject` metadata from
  `@deepseek-ai/cordis-plugin-loader`.
- **Confirmation token verification**: `dsh.approval` and `dsh.question_approval` verify
  `action._meta["nia/confirmationToken"]` via `createWorkloadOidcVerifier` from
  `@nia-teams/mcp-sdk/auth` against the paired `issuer`, `nia-teams-workload` audience,
  `server: "agent-bridge"`, exact `tool` and `arguments` digest, and `expectedCardId`.
  Missing/tampered tokens fail closed. Ordinary approvals return `'allowed-once'`,
  never mutating `sessionAllowTools`; that list is explicit operator preauthorization.
- **Ownership & session isolation**: Use `stableExternalAgentThreadId(groupChatId, teamId)`.
  `nia_group_chat_send_message` and `nia_group_chat_history` enforce `ownsAgent(agent)`
  (root + `isOwnedBy` descendants) at both presentation and execution. Child-agent
  final text stays private to the parent. Preserve Nia session IDs on publication retries.
- **Contract sync & verification**: Changes to CLI flags, `Config`, exported APIs, or
  Agent Bridge v1 frames update `docs/SPECIFICATION.md`, `skills/nia-teams-dsh/SKILL.md`,
  `README.md`, and `README_CN.md` together. Run `npm run typecheck`, `npm run build`,
  `npm test`, and check `npm pack --dry-run` against `package.json` `files`.

Shared bridge modules are thin re-exports from @nia-teams/agent-bridge-core. Preview packaging preserves named Harness exports and bundles runtime dependencies; nia-dsh remains pair/status, not a second Harness daemon.
