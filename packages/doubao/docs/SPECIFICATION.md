# Doubao desktop-authenticated HTTP + official native CLI contract

Pinned driver: MIT `doubao-cli@0.23.3`, Node >=22. Both local usage modes remain first-class. `work`/`doubao` select desktop AUTHENTICATION, not desktop webpack/DOM task execution. `cli` remains the separate official @bytedance/doubao-cli transport; explicit `headless` uses pre-provisioned independent HTTP credentials.

## Verified upstream findings

- `src/headless.mjs:350–395`: local create/send WITHOUT --wait is supported, but starts an upstream detached submission/runtime worker. Thus --wait is not strictly required by 0.23.3; it IS chosen by this bridge to keep one owned, foreground local executor for the entire turn and avoid detached task ownership.
- `src/headless.mjs:435–454, 502–517`, `src/headless-turn.mjs:3–19`: with --wait, local tool-channel startup races with server-turn observation; worker remains connected and closes the engine in finally. `options.onAccepted` is called at acceptance, before final result. This gives cancellation IDs without split submit/wait or orphaning the runtime.
- `src/headless.mjs:219–229`: executeHeadless accepts programmatic confirmFullAccess / fullAccessConfirmed. CLI --yes does NOT grant this consent. The bridge supplies confirmFullAccess only from explicit trusted --full-auto for that invocation; no global environment consent or automatic TTY answers are used.
- `src/headless-approval.mjs:108–145`: ordinary approval defaults to false without an interactive stdin/stderr TTY. `src/headless-local-runtime.mjs:156–173, 1040–1067`: AskOnRisk allows ordinary in-workspace reads but commands/writes/connector/outside-workspace access require approval; FullAccess has no per-tool risk prompt. Workspace writes independently require approval unless FullAccess (`:990–1000`). The unattended bridge defaults AskOnRisk and denies restricted tools; it does not invent a TaskBar approval callback.
- `src/options-contract.mjs:25` and `src/headless.mjs:350–371`: --mode is create-only. Create defaults work and local runtime cannot use chat; sends infer prior conversation mode. Both desktop variants use --mode work on create, none on send. Goal is an optional account-gated feature and not a synonym for Doubao.app.
- `src/headless-local-runtime.mjs:1090+`: portable local file/text and shell operations execute in workspace. Not every native desktop capability is portable; media/PDF Read is explicitly unsupported.
- `src/app.mjs:37–48`, `src/turns.mjs:309–327`: executeHeadless must run inside withApp(resolvePlatform('headless'), ...), otherwise currentApp/receipt scope defaults to a desktop identity and stop will not share its receipt scope. The per-turn bridge worker pins the proper context.
- `src/headless.mjs:68–80,250–272`: environment CookieJar is verified against account API and not saved as a login file. --cookie-file explicitly imports a separate HTTP login. Cookie refresh does not require desktop module discovery.

## Desktop CDP auth

Desktop app defaults are work -> DoubaoWork.app/9226/doubaowork:, doubao -> Doubao.app/9225/doubao:. Auto selection is unchanged: explicit native binary -> cli; otherwise installed macOS work -> doubao; otherwise official native runtime/PATH; missing installations fail closed. Headless remains explicit-only.

Ready runs driver cdp status, optional cdp launch with --yes ONLY for explicit --restart-app, and a cookie probe. No models or sessions-list DOM/module scraping is required. Upstream cdp launch itself still calls listModels after starting CDP (`src/cli.mjs:115–130, 504–540`); the bridge rechecks CDP after launch even on that command's model-menu failure. Only a verified now-available correct endpoint counts as ready; a running app without authorized restart remains an error. Upstream launch uses open -a (not -g), so startup may foreground the app. No turn launches, restarts, opens or navigates it.

`desktop-auth.ts` fetches /json/list (bounded 5s) from loopback HTTP, requires an expected app-scheme chat page, rejects an app login target, validates a same-endpoint local WebSocket, and issues only Network.getAllCookies. Filter domains exactly doubao.com or suffix .doubao.com; filter expired/invalid entries; require nonempty sessionid or sid_tt. Unauthenticated/error responses produce static actionable messages, never raw cookie/CDP response or error causes.

Cookies are read at ready AND before each turn, so logout is not masked by cached credentials and refreshed login state reaches the next worker. A per-turn immutable snapshot goes only in child DOUBAO_HEADLESS_COOKIE environment, not argv/IPC/logs/bridge storage; parent process.env is unchanged. The stop command uses the SAME snapshot as its active run, not cookies from a potentially switched desktop account. Requests for inaccessible old-account conversations fail closed, never silently resend.

## Task worker and authorization

One foreground child imports the real driver's parser and executeHeadless, selecting headless app context. Parent sends args/fullAuto over private IPC; the cookie stays solely in env. Driver auto-update is disabled. Local arguments are:

```text
--platform headless --json sessions create --mode work
  --runtime local --workspace <absolute cwd> --permission AskOnRisk
  [--model <name>] --wait --timeout 120 -- <prompt>
--platform headless --json sessions send <rawConversationId>
  --runtime local --workspace <absolute cwd> --permission AskOnRisk
  [--model <name>] --wait --timeout 120 -- <prompt>
```

--full-auto uses FullAccess with confirmFullAccess returning true in that invocation. Cloud omits local workspace/permission. The literal -- prevents prompt option injection. No goal mode is automatically selected. The worker never calls main/login/updater; no DOM/webpack task API, sandbox module lookup, model menu or desktop native runtime device identity is needed. HTTP runtime uses its own routing device metadata; receipt handling and stop retain that identity through upstream's receipt store.

Worker onAccepted emits only public conversationId/runId/status. Parent persists the backend namespace early, suppressing persistence after cancellation. Final publication requires matching accepted IDs, status completed and nonempty bounded reply.text. Worker result/error serialization drops upstream error messages, causes, headers, request bodies and recovery details; only whitelisted receipt/status/reply fields cross IPC. Neither stdout nor stderr of the worker is forwarded.

On abort with known IDs, parent independently calls `node <bundled-driver> --platform headless --json sessions stop <rawId> --run <runId> --timeout 15`, keeping the worker's local runtime alive during stop, then terminating that worker with bounded SIGTERM/SIGKILL cleanup. Before receipt, cancellation waits for bounded acceptance (task watchdog 130s). No receipt means stop is unconfirmed; there is no resend. The same stop path handles uncertain/nonterminal failures. A process exit alone is not claimed as remote termination. Native SIGINT/SIGTERM alone has no magic remote-stop guarantee.

Namespaces remain work:<id>, doubao:<id>, cli:<id>, headless:<id>. Match only the active backend prefix; foreign/legacy values create fresh conversations. Desktop-auth HTTP execution retains work/doubao prefixes. Shared core owns per-chat persistence and publication semantics.

## Official native CLI (unchanged)

Native runtime discovery prefers OS app-data runtime then PATH, excludes bundled CDP wrapper and resolves executable symlinks. --doubao-bin is official CLI-only. Ready checks auth status --verify before Nia connects. If unauthenticated, only interactive local stdin/stdout TTY (or explicit API override) may spawn login with inherited stdio; post-login re-verification is mandatory. Non-TTY/failed login fails closed. QR never travels through GroupChat.

Turns use -C <cwd> --permission-mode ask_always|always_allow [--model] [--resume rawId] -p <prompt>. stdout reply, stderr session marker, local process-group cancellation; no imaginary JSON/MCP approval transport or claim that remote native tasks are guaranteed stopped. Native session ownership is separate from desktop/HTTP cookies.

## Verification boundaries

Tests use real local HTTP + WebSocket CDP fixtures for both app identities, blocked login targets, missing/expired/foreign cookies, errors with secret-bearing payloads, ready/per-turn refresh, unchanged parent environment, matching namespace resume and run cancellation. Real driver parser and portable executor tests cover AskOnRisk read/Bash denial and FullAccess shell execution; task network and official QR/account operations are mocked. Preview tests install offline, probe real bundled imports/version/status, and mock only task transport inside the isolated install for daemon publication. User-provided live 2.36.3 evidence establishes end-to-end desktop-cookie-authenticated local execution; this sandbox does not claim a new authenticated macOS model test.

## GroupChat sender identity and mentions

Incoming messages carry sender metadata, for example `[chat:<chatId>] Alice (<userId>): ...`, or `senderId` in structured channel payloads. This bridge's raw `thread.message` uses `messages[].authorId`; its formatted prompt lists `Alice (<userId>)` and member IDs. Use the received sender/member ID, not the display name.

To notify a member with a native Nia Teams highlight, emit `<mention userId="<userId>" />` in the published reply. Plain `@Name` is text, not a real mention. Do not invent IDs; consult the member list/history if needed.
