# Claude Code adapter maintenance

- This package runs the Claude Agent SDK daemon; `cli.ts` owns connect, pair, status, and start.
- `runner.ts` supplies `createClaudeRunner` to core `SessionHost`; core owns credentials, pairing, transport, state, queues, and signed cards.
- Pin `@anthropic-ai/claude-agent-sdk` and update `docs/SPECIFICATION.md` with package evidence when changing versions.
- Preserve `pathToClaudeCodeExecutable`, Windows wrapper handling, the Claude Code system preset, and `strictMcpConfig: true`.
- Keep GroupChat tools scoped to the active turn; replies require explicit `send_message`.
- `AskUserQuestion` waits for the invoking human; other permissions require core verification of signed `claude_code.permission` cards.
- Preserve sender/member IDs and native `<mention userId="..." />` mentions.
- Synchronize both guides, the shipped skill, package files, exports, and the runtime specification.
- From the repository root run `npm install`, `npm run build`, `npm run typecheck`, `npm test`, `npm run verify:docs`, and `npm pack --dry-run -w @nia-teams/claude-code-plugin`.
