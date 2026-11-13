# WorkBuddy / CodeBuddy upstream contract

Inspected npm `@tencent-ai/agent-sdk@0.3.300` and `@tencent-ai/codebuddy-code@2.180.0`. SDK declarations and live CLI help are retained in `upstream/`.

- `query({ prompt, options })` is AsyncIterable of system/assistant/result messages. `session_id` identifies the durable runtime conversation; `resume` restores it. Success carries `type: "result", subtype: "success", result: string`; errors carry `is_error`/`errors`.
- Executable override: `pathToCodebuddyCode`. There is no `pathToCodeBuddyExecutable` option. Options include `cwd`, `model`, `abortController`, `canUseTool`, `mcpServers`, `permissionMode`, `settingSources`, `env`.
- SDK transport uses `--input-format=stream-json --output-format=stream-json --verbose`, `--resume`, `--setting-sources`, `--permission-mode`; it chooses Node for JS launchers and direct execution for `.exe`.
- SDK initialize control request carries `sdkMcpServers` and `capabilities.askUserQuestion: true`. In-process tools use `createSdkMcpServer` and `tool` from the same SDK, with Zod schemas and MCP content results.
- CLI → SDK `control_request.request.subtype: "can_use_tool"` includes `tool_name`, `input`, `tool_use_id`. Callback is `(toolName, input, { signal, toolUseID, ... })`. SDK callbacks return `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`; SDK translates these to its own `{ allowed, ... }` wire response. Do not substitute Claude's control response shape.
- Cancellation sets AbortController and calls query `interrupt()`; upstream returns a terminal result and cleans up the transport. Cancellation is cooperative with the selected CLI.
- `AskUserQuestion` can surface through this callback. Answers are supplied in `updatedInput.answers`, keyed by question text.
- SDK defaults setting sources to `none`; bridge explicitly enables user/project/local to preserve local settings. `CODEBUDDY_CONFIG_DIR`, `WORKBUDDY_CONFIG_DIR`, `CODEBUDDY_AUTH_TOKEN`, `CODEBUDDY_API_KEY` and the selected build's product authentication are inherited, not synthesized. CodeBuddy standard data is `.codebuddy`; WorkBuddy product-specific configuration uses `.workbuddy` (including models.json). Sharing Desktop auth is not presumed for a different CodeBuddy build.

SHA256:

```text
a1bd88faf1f7c28d27d5975d2882ccd91d9b9206fdb0c5014d899519619a6aa9  tencent-ai-agent-sdk-0.3.300.tgz
602071561129a332c88b628650a3e15925a84a82f5cccce7b5cc4fbfbb0509a2  tencent-ai-codebuddy-code-2.180.0.tgz
```

TaskBar cards bind the full tool/input, active turn identity, and card ID through core `verifyCardApproval`, tool `workbuddy.approval`, server `agent-bridge`. UI clicks alone grant nothing. GroupChat tool calls are scoped by host context, not a model-supplied chat/session identifier.

## Desktop entrypoint interoperability

`agent-sdk@0.3.300` passes `pathToCodebuddyCode` to its process transport as `executablePath`. The transport rewrites any Unix `bin/codebuddy` suffix to `dist/codebuddy-headless.js` without checking existence, even with `executable`/`executableArgs` specified. It does not rewrite `.mjs`/`.js` entrypoints or dereference symlinks. WorkBuddy.app distributions may ship only `dist/codebuddy-lite-wb.mjs`, so executable discovery normalizes the installation to that readable ESM entrypoint before the single SDK query path. Standard CLI distributions without that bundle retain their original entrypoint. Explicit script entrypoints require readability, not an OS executable bit.

The SDK merges `{ ...process.env, ...options.env }`; desktop overrides do not remove PATH/HOME. Desktop credential decryption locates `Contents/MacOS/Electron` from the `WorkBuddy.app` root, which is unchanged by selecting `cli/dist` instead of `cli/bin`. Tests cover the real SDK spawn/initialize/MCP/permission/resume/result/error protocol using a desktop-only mock distribution, plus encrypted desktop auth and standalone preview installation.


Desktop credential decryption invokes `Electron -e <inline-script> <auth-file-path>` with `ELECTRON_RUN_AS_NODE=1` and `NODE_OPTIONS=''`. The WorkBuddy storage linked binding is available in this build's NodeMain mode, avoiding browser/NSApplication startup and desktop focus activation. The child reads the existing credential file; only its path (not the envelope, token, or at-rest key) travels in argv. JSON token output is captured in memory. No temporary scripts, stdin envelopes, or output files are used. Child errors/output are never attached to reported errors. The existing in-memory `(auth path, CLI path, mtimeMs)` promise cache deduplicates concurrent decryptions, refreshes on mtime changes, and evicts rejected promises. Plaintext desktop credentials and explicit `CODEBUDDY_AUTH_TOKEN` bypass Electron decryption.

## GroupChat sender identity and mentions

Incoming messages carry sender metadata, for example `[chat:<chatId>] Alice (<userId>): ...`, or `senderId` in structured channel payloads. This bridge's raw `thread.message` uses `messages[].authorId`; its formatted prompt lists `Alice (<userId>)` and member IDs. Use the received sender/member ID, not the display name.

To notify a member with a native Nia Teams highlight, emit `<mention userId="<userId>" />` in the published reply. Plain `@Name` is text, not a real mention. Do not invent IDs; consult the member list/history if needed.
