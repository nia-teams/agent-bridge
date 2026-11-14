import { runInviteConnectCli, inviteDaemonArgs, findExecutable } from '@nia-teams/agent-bridge-core';
import { maybeRespawnDaemon } from '@nia-teams/agent-bridge-core';
import { clientBranding } from './branding.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { BridgeClient, defaultConfigDir, loadCredentials, runPairingCli } from '@nia-teams/agent-bridge-core';
import { CodexHost } from './host.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'invite-code': { type: 'string' }, 'user-name': { type: 'string' }, 'agent-name': { type: 'string' }, 'no-browser': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    daemon: { type: 'boolean' }, 'log-file': { type: 'string' },
    'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' }, model: { type: 'string' }, sandbox: { type: 'string' }, 'full-auto': { type: 'boolean' }, 'bypass-approvals': { type: 'boolean' }, 'codex-bin': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length === 0) {
    console.log('nia-codex connect --invite-code <code> [--user-name <name>] [--agent-name <name>] [--no-browser] [--no-start] [--cwd <dir>] [--daemon] [--log-file <path>]\nnia-codex pair [--server-url <url>] [--config-dir <dir>] [--name <label>]\nnia-codex start [--daemon] [--log-file <path>] [--config-dir <dir>] [--cwd <dir>] [--model <model>] [--sandbox <read-only|workspace-write|danger-full-access>] [--full-auto] [--codex-bin <path>]\nnia-codex status [--config-dir <dir>]'); return;
  }
  if (positionals.length !== 1) throw new Error('Expected one command');
  const configDir = resolve(values['config-dir'] ?? defaultConfigDir('nia-teams-codex', 'NIA_CODEX_CONFIG_DIR'));
  if (positionals[0] === 'connect') {
    if (!values['invite-code']) throw new Error('connect requires --invite-code');
    if (!values['no-start']) {
      const binary = values['codex-bin'] ?? process.env.CODEX_BIN ?? 'codex';
      await findExecutable(binary, /[/\\]/.test(binary) ? binary : undefined);
      if (values.sandbox && !['read-only', 'workspace-write', 'danger-full-access'].includes(values.sandbox)) throw new Error('Invalid sandbox mode');
    }
    await runInviteConnectCli({ configDir, hostPrefix: 'codex', ...clientBranding,
      inviteCode: values['invite-code'], userName: values['user-name'], agentName: values['agent-name'],
      serverUrl: values['server-url'], hostLabel: values.name, openBrowser: !values['no-browser'] });
    if (!values['no-start']) await maybeRespawnDaemon(inviteDaemonArgs({ ...values, 'config-dir': configDir }), resolve(configDir, 'daemon.log'));
    return;
  }
  if (positionals[0] === 'pair') {
    await runPairingCli({ configDir, hostPrefix: 'codex', ...clientBranding, cliCommandName: 'nia-codex', serverUrl: values['server-url'], hostLabel: values.name }); return;
  }
  if (positionals[0] === 'status') {
    const c = await loadCredentials(configDir);
    console.log(`Agent: ${c.agentName} (@${c.agentSlug})\nServer: ${c.serverUrl}\nTeam: ${c.teamId}\nConfig: ${configDir}`); return;
  }
  if (positionals[0] !== 'start') throw new Error('Unknown command: use pair, start, or status');
  if (await maybeRespawnDaemon(args, resolve(configDir, 'daemon.log'))) return;
  if (values.sandbox && !['read-only', 'workspace-write', 'danger-full-access'].includes(values.sandbox)) throw new Error('Invalid sandbox mode');
  const bridge = new BridgeClient(await loadCredentials(configDir), { ...clientBranding, onError: error => console.error(error.message) });
  const host = new CodexHost(bridge, { configDir, cwd: resolve(values.cwd ?? process.cwd()), model: values.model, sandbox: values.sandbox as 'read-only' | 'workspace-write' | 'danger-full-access' | undefined, fullAuto: values['full-auto'] || values['bypass-approvals'], codexBin: values['codex-bin'], onError: error => console.error(error.message) });
  const stop = async () => { bridge.close(); await host.close(); };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  try { await host.start(); await bridge.start(); }
  catch (error) { await stop(); throw error; }
}
