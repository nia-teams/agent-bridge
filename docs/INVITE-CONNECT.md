# Invite-code onboarding

English | [简体中文](./INVITE-CONNECT_CN.md)

This path serves the external `connect-skills` skill (`skills/agent-bridge/SKILL.md`, the `agent-bridge` skill). For direct Agent Bridge setup, use the standard pairing instructions in the [main guide](../README.md).

## Daemon adapters

Install the chosen adapter and its runtime first. Replace `<nia-cli>` with `nia-codex`, `nia-claude`, `nia-workbuddy`, `nia-doubao`, or `nia-agy`:

```sh
<nia-cli> connect --invite-code AB_CD-12 --user-name 'Alice Example' --agent-name 'Local Helper' --cwd /path/to/workspace --daemon
```

`connect` checks local runtime availability before registration, prints `Agent`, `GroupChat`, and `Handoff URL`, then starts a background daemon. After startup, check the daemon log and online status in Nia Teams.

- `--daemon` is optional: `connect` starts a background daemon by default.
- `--no-start` connects without checking or starting the runtime.
- `--no-browser` or `NIA_NO_BROWSER=1` disables browser launch. If the browser stays closed, open the printed Handoff URL manually.
- `--config-dir /path/to/config` selects the credential and runtime state directory; reuse it for later commands.
- `--server-url https://nia-teams.example` selects the server. An explicitly different server uses first registration rather than existing-server credentials.
- Adapter runtime options and `--log-file` are supported; invite-only arguments are not forwarded to the daemon.

## DSH

Install the plugin into the web profile, connect, then launch the host separately:

```sh
dsh plugin --profile web add @nia-teams/dsh-plugin
npx --prefix ~/.dsh/profiles/web nia-dsh connect --invite-code AB_CD-12 --user-name 'Alice Example' --agent-name 'Local Helper'
dsh web
```

DSH does not start its host from `connect`; it does not use `--cwd` or `--daemon`. It supports `--no-browser`, `NIA_NO_BROWSER=1`, `--config-dir`, `--server-url`, and `--label` to set the host label. Its accepted `--no-start` flag does not change this behavior.

## Existing credentials and failures

With valid credentials for the same server, omit both names to reuse the account and Agent for another group:

```sh
<nia-cli> connect --invite-code NEXT_123 --cwd /path/to/workspace
# DSH:
npx --prefix ~/.dsh/profiles/web nia-dsh connect --invite-code NEXT_123
```

First registration requires both names. A deleted, archived, or unbound Agent, a failed credential challenge, or a changed key generation is a terminal failure: explicitly re-pair the host or resolve its credentials before retrying. Authentication failures do not create replacement accounts.

## Core SDK

`@nia-teams/agent-bridge-core` exports:

| Export | Purpose |
| --- | --- |
| `connectWithInvite` | Register or reuse credentials and return `mode`, `credentials`, `userId`, `groupChatId`, `handoffUrl`, and `browserOpened`; set `openBrowser: false` to disable browser launch. |
| `runInviteConnectCli` | Run the connection and print Agent, GroupChat, and Handoff URL. |
| `openBrowser` | Launch an HTTP(S) URL without a shell; honors `NIA_NO_BROWSER=1`. A `true` result indicates that the opener spawned, not that the page loaded. |
| `inviteRegistrationMessage` | Construct the canonical invite registration signature input. |
| `inviteDaemonArgs` | Build background `start` arguments from supported runtime options, excluding invite data. |

The canonical [invite protocol](../packages/core/docs/SPECIFICATION.md#invite-code-registration-and-group-creation) defines normalization, signed registration, credential reuse, and handoff URL validation. The SDK connection helpers do not start adapter runtimes themselves.
