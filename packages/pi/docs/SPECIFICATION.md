# Pi Coding Agent bridge

This adapter uses [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) to drive the separately installed CLI. The Nia Teams connection is the shared [Agent Bridge WebSocket protocolVersion: 3](https://github.com/nia-teams/agent-bridge/blob/6f265d7/packages/core/docs/SPECIFICATION.md).

## Turn lifecycle

`SessionHost` resolves the GroupChat prompt, supplies `ready.systemPrompt` and `ready.tools`, and owns the `ThreadMapStore`. A turn starts one `pi --mode rpc` process in the selected workspace. `--append-system-prompt` points to a private temporary file, and `--session-dir` points to the adapter's local sessions directory. The adapter saves the absolute `get_state` response's `data.sessionFile`; the next turn opens it via `--session`.

Before prompting, a missing file or a session-specific load failure permits one fresh process. Other startup failures surface to the host. The adapter never replays a submitted `prompt`. On cancellation it requests `abort`, then terminates Pi if it has not exited after two seconds. Normal shutdown closes stdin first. Both paths clean up the MCP server and prompt file.

The process transport frames UTF-8 records on LF, accepting a preceding CR. Responses match request IDs; event observation starts before `prompt`. A `tool_execution_start` event updates executing activity. Pi retains native tool permissions; headless extension `select`, `confirm`, `input`, and `editor` requests receive `extension_ui_response` with `cancelled: true`. Notifications and status updates need no reply.

## Turn completion

- **Pi 1.6.0 and later builds with the same RPC contract**: `prompt` acknowledges with `data.disposition` (`started`, `queued`, or `handled`). The bridge returns for `handled` and otherwise requires `agent_settled`. An `agent_end` alone is never sufficient on this path.
- **Pi 0.74.2 (the Node.js 20 release)**: a successful `prompt` acknowledgment contains no `data`; an extension-handled prompt has the same acknowledgment and no run events. The release emits `agent_end`, `auto_retry_start` / `auto_retry_end`, and `compaction_start` / `compaction_end`, but not `agent_settled`. Its SDK helpers resolve on the first `agent_end`, which can precede retry or compaction. The bridge instead waits for a quiet interval and confirms `get_state` has no streaming, compaction, or queued prompts. It requires `agent_end` before probing for idle; a retry or `compaction_end.willRetry` invalidates that boundary until the next run ends. An acknowledgment with no run event is ambiguous: after 30 seconds without a run boundary the bridge reports an error instead of claiming success. Use Pi 1.6.0 or later for extension-handled prompts.

The branch is selected from the acknowledgment shape, not the CLI version string. Remove the idle-probe path when support for pre-disposition Pi is dropped.

## Collaboration tools

The bundled `dist/pi-extension.js` imports no Pi package. It reads a per-turn loopback endpoint and bearer token from the Pi child's environment, initializes MCP Streamable HTTP, registers `tools/list` entries with their supplied JSON Schemas, and forwards `tools/call` to core `ToolHttpServer`. Core handles `tool.call` on the authenticated bridge. The child does not receive the Nia signing key from the adapter. Only explicit calls such as `send_message` publish replies; Pi's assistant text stays local.
