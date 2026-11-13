# Codex app-server protocol contract

## Source and reproduction

Verified against npm `@openai/codex@0.167.0-linux-x64` (the platform alias used by `@openai/codex@0.167.0`). Evidence in `protocol/` comes from the real binary:

```sh
npm pack @openai/codex@0.167.0-linux-x64
tar xzf openai-codex-0.167.0-linux-x64.tgz
./package/vendor/x86_64-unknown-linux-musl/bin/codex app-server generate-ts --out ./schema --experimental
```

`protocol/*.ts` are unmodified generated excerpts for review, not compilable application modules; their imported supporting definitions are not vendored. Binary SHA256 is recorded in `protocol/binary-sha256.txt`. A live no-model smoke check also accepted `initialize`, `initialized`, and `thread/start` with both dynamic tools, read-only sandbox, on-request policy, and user reviewer.

## JSONL handshake

One JSON object per newline over stdin/stdout; requests/responses include numeric or string IDs. The bridge sends JSON-RPC 2.0 envelopes. Initialize clientInfo is `{ name: "nia-teams-codex-bridge", title: "Nia Teams Codex Bridge", version: "0.1.0" }` with `capabilities: { experimentalApi: true }`; wait for its response, then notify `initialized` with `{}`.

## Thread and turn shapes

- `thread/start`: `cwd`, `model`, `developerInstructions`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `dynamicTools`. Response is `{ thread: { id, ... }, ... }`; the adapter also accepts `threadId` for an external compatibility window requested by the integration contract.
- Dynamic tool specs require **`type: "function"`**, `name`, `description`, `inputSchema` in 0.167.0. Flat specs without `type` are not this schema.
- `thread/resume`: `threadId` and runtime overrides. **No `dynamicTools` parameter**; tools belong to the saved thread. Response contains `thread.id`.
- `turn/start`: `threadId`, `input: [{ type: "text", text, text_elements: [] }]`. The generated text input includes **`text_elements`**. Response contains `turn.id`.
- `turn/steer`: `threadId`, `input`, **`expectedTurnId` required**.
- `turn/interrupt`: `{ threadId, turnId }`.
- `item/completed`: `{ threadId, turnId, completedAtMs, item }`. Agent text is `item: { type: "agentMessage", id, text, phase, ... }`.
- `item/agentMessage/delta`: `{ threadId, turnId, itemId, delta }`.
- `turn/completed`: `{ threadId, turn: { id, status, items, error, ... } }` — not a top-level `turnId`.

## Bidirectional tools

Server request `item/tool/call`: `{ threadId, turnId, callId, namespace, tool, arguments }`. Response: `{ contentItems: [{ type: "inputText", text }], success: boolean }`. This is not MCP `content`/`isError`.

`nia_group_chat_send_message` accepts `{ content: string }`; `nia_group_chat_history` accepts `{ limit?: 1..100, offset?: integer >= 0 }`. The host supplies the active Nia session ID; models cannot choose another chat/session.

## Approvals

- v2 `item/commandExecution/requestApproval` includes `kind`, `threadId`, `turnId`, `itemId`, `startedAtMs`, `environmentId`, optional command/cwd/reason/approvalId/availableDecisions.
- v2 `item/fileChange/requestApproval` includes `threadId`, `turnId`, `itemId`, `startedAtMs`, optional reason/grantRoot. **It does not carry the patch.** The adapter obtains file changes/preview from preceding item lifecycle notifications when available, and shows the request otherwise.
- v2 responses are `{ decision: "accept" | "decline" | "cancel" | ... }`.
- v1 `execCommandApproval` uses **`conversationId`**, `callId`, a **command array**, cwd and optional reason/approvalId.
- v1 `applyPatchApproval` uses `conversationId`, `callId`, **`fileChanges`**, reason/grantRoot.
- v1 responses use **`"approved"`** or **`{ denied: { rejection: string } }`**, not v2 `accept`/`decline`.

TaskBar cards bind `verifyToolName: "codex.approval"`, request arguments and the card ID. `verifyCardApproval` delegates RS256 issuer/audience/signature/expiry and context validation to core's MCP SDK verifier. A UI decision alone grants nothing. Timeout, cancellation, failed verification, turn interruption and session rotation decline pending requests and cancel cards. Unknown server requests receive `-32601`; no implied approval.

Agent Bridge v1 signing and wire shapes are specified in `../../core/docs/SPECIFICATION.md`.

## GroupChat sender identity and mentions

Incoming messages carry sender metadata, for example `[chat:<chatId>] Alice (<userId>): ...`, or `senderId` in structured channel payloads. This bridge's raw `thread.message` uses `messages[].authorId`; its formatted prompt lists `Alice (<userId>)` and member IDs. Use the received sender/member ID, not the display name.

To notify a member with a native Nia Teams highlight, emit `<mention userId="<userId>" />` in the published reply. Plain `@Name` is text, not a real mention. Do not invent IDs; consult the member list/history if needed.
