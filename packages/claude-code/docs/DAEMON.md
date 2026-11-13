# Headless daemon mode

Inspected npm `@anthropic-ai/claude-agent-sdk@0.3.319` declarations and implementation. Package metadata is retained in upstream/. SDK archive SHA256: `6bfb9ccb6a5d15686f5c7dd12d7a7da6d7b486ca6e1331ac8a7ab98a2d302001`.

`nia-claude start` is separate from the existing experimental channel MCP mode. It uses `query({ prompt, options })` with `pathToClaudeCodeExecutable`, `cwd`, `model`, `resume`, `abortController`, `canUseTool`, and in-process `createSdkMcpServer`/`tool`. No interactive PTY or `--dangerously-load-development-channels` acknowledgement is needed for this SDK path. A local authenticated Claude CLI is still required.

The SDK invokes stream-json input/output with `--verbose`, `--permission-prompt-tool=stdio`, and `--resume=<sessionId>`. Initialize negotiates SDK MCP servers/manifests. `canUseTool` returns behavior allow/deny and updatedInput, unlike Tencent's translated wire `allowed` field. Native final SDK result messages contain `session_id`, `subtype: success`, and `result: string`; errors carry `is_error` and errors. Subagent assistant messages are not published as main-turn replies.

Default permission mode is `default`; full-auto selects `bypassPermissions` and `allowDangerouslySkipPermissions`. User/project/local settings are enabled. Existing upstream allow rules and hooks remain in effect; TaskBar only receives requests that the upstream permission engine forwards. GroupChat send/history are intentionally allowlisted and remain scoped to the current host context. SDK warnings about their canUseTool bypass describe this intentional allowlist.

Per-GroupChat runtime IDs live in private threads.json. `AskUserQuestion` publishes questions and waits for the invoking human; multiple questions use a JSON answer map. Upstream tool requests use signed TaskBar `claude_code.permission` verification. Session rotation and cancellation abort the query and pending cards. Core owns state persistence, publication retries, and macOS sleep prevention.

The previous `.claude-plugin`, `.mcp.json`, `nia-claude mcp` channel server, tool names and permission flow are unchanged. Do not run channel mode and daemon mode concurrently with the same paired credentials.

The runner sets `strictMcpConfig: true`, which adds `--strict-mcp-config` in the SDK CLI invocation. Only the supplied scoped `nia` MCP server is loaded; inherited MCP server configuration is ignored. This complements the `NIA_CLAUDE_DAEMON=1` child marker that disables accidental legacy channel connections.
