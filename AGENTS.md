# Maintainer guidance

- Core is the sole owner of Agent Bridge v1 signing, pairing, credentials, WebSocket validation, confirmation verification and publication retries.
- Adapter-local files for migrated APIs are compatibility exports, not independent implementations.
- Packages target Node 20+ ESM, except Doubao which requires Node 22+. Keep stdout JSONL-only for stdio protocols.
- Codex protocol changes require regenerating types from the pinned binary and updating docs/protocol evidence and mock integration tests.
- Confirmation tokens bind tool, arguments and card identity; never accept an unsigned card action.
- Run `npm install`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run verify:docs` before delivery.

- JsonFileStore/ThreadMapStore own atomic adapter state; Codex retains its existing on-disk mapping shape through a thin wrapper. IdleSleepGuard owns macOS caffeinate.
- SessionHost owns SDK-style single-turn lifecycles and signed cards; adapters supply only upstream runners.
- WorkBuddy SDK 0.3.300 uses pathToCodebuddyCode; Claude SDK 0.3.319 uses pathToClaudeCodeExecutable. Test with real SDKs and protocol-speaking mock children.
- Doubao 2.31.2 rejects headless interactive requests itself and exports no approval-reply or MCP path. Do not invent stream-json flags or authorize unsupported interactions.

- Preserve sender IDs (`messages[].authorId` in raw frames); document channel `senderId` separately. Real mentions use `<mention userId="<userId>" />`, never plain display-name text.
- Keep README/README_CN, adapter skills, package file lists and protocol docs in sync. Skills must check status before pairing, monitor browser pairing, and background long-running hosts with log/process plus Nia Teams connectivity checks.
- DSH has `pair --label` and `status`; execution belongs to `dsh web`. Other adapters support `pair --name` and `start --cwd`. Use successful Agent/Server status output to reuse existing credentials.
- Repository Markdown has no title frontmatter; skill frontmatter has only name and English description. Public docs use https://nia-teams.com and fictional IDs.

- Antigravity uses one persistent ACP child with per-chat sessions supplied by core ThreadMapStore. Match client responses by ID; route server updates/permissions by ACP sessionId and child generation.
- ACP permission verdicts use context.permission (not an invented requestApproval API), verifier tool agy.approval, and one-shot option IDs. Scoped MCP helpers get ephemeral per-turn loopback capabilities, never Nia private keys.
- Abort sends session/cancel, terminates an unresponsive generation after two seconds, and never replays a failed prompt. Only explicit resume RPC errors permit session/new. CLI owns runner.close in finally around runSessionDaemon.
