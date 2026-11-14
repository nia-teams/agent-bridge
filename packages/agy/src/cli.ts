import { runInviteConnectCli, inviteDaemonArgs } from '@nia-teams/agent-bridge-core';
import { maybeRespawnDaemon } from '@nia-teams/agent-bridge-core';
import { clientBranding } from './branding.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultConfigDir, loadCredentials, runPairingCli, runSessionDaemon } from '@nia-teams/agent-bridge-core';
import { createAgyRunner, resolveAgyBinary, type AgyMode } from './runner.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'invite-code': { type: 'string' }, 'user-name': { type: 'string' }, 'agent-name': { type: 'string' }, 'no-browser': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    daemon: { type: 'boolean' }, 'log-file': { type: 'string' },
    'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, name: { type: 'string' }, label: { type: 'string' }, 'timeout-ms': { type: 'string' },
    cwd: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' }, sandbox: { type: 'boolean' }, 'full-auto': { type: 'boolean' },
    'bypass-approvals': { type: 'boolean' }, 'agy-bin': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) { console.log('nia-agy connect --invite-code <code> [--user-name <name>] [--agent-name <name>] [--no-browser] [--no-start] [--cwd <dir>] [--daemon] [--log-file <path>]\nnia-agy pair [--server-url <origin>] [--config-dir <dir>] [--name <label>] [--label <label>] [--timeout-ms <ms>]\nnia-agy status [--config-dir <dir>]\nnia-agy start [--daemon] [--log-file <path>] [--cwd <dir>] [--config-dir <dir>] [--model <model>] [--mode default|accept-edits|auto|plan] [--sandbox] [--full-auto] [--bypass-approvals] [--agy-bin <path>]'); return; }
  if (positionals.length !== 1) throw new Error('Expected one command');
  const configDir = resolve(values['config-dir'] ?? defaultConfigDir('nia-teams-agy', 'NIA_AGY_CONFIG_DIR'));
  if (positionals[0] === 'connect') {
    if (!values['invite-code']) throw new Error('connect requires --invite-code');
    if (!values['no-start']) {
      await resolveAgyBinary(values['agy-bin']);
      if (values.mode && !['default', 'accept-edits', 'auto', 'plan'].includes(values.mode)) throw new Error('Invalid --mode');
    }
    await runInviteConnectCli({ configDir, hostPrefix: 'agy', ...clientBranding,
      inviteCode: values['invite-code'], userName: values['user-name'], agentName: values['agent-name'],
      serverUrl: values['server-url'], hostLabel: values.name ?? values.label, openBrowser: !values['no-browser'] });
    if (!values['no-start']) await maybeRespawnDaemon(inviteDaemonArgs({ ...values, 'config-dir': configDir }), resolve(configDir, 'daemon.log'));
    return;
  }
  if (positionals[0] === 'pair') {
    await runPairingCli({ configDir, hostPrefix: 'agy', ...clientBranding, cliCommandName: 'nia-agy', serverUrl: values['server-url'], hostLabel: values.name ?? values.label, timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']) }); return;
  }
  if (positionals[0] === 'status') {
    const c = await loadCredentials(configDir); console.log(`Agent: ${c.agentName} (@${c.agentSlug})\nServer: ${c.serverUrl}\nTeam: ${c.teamId}\nConfig: ${configDir}`); return;
  }
  if (positionals[0] !== 'start') throw new Error('Unknown command: use pair, status, or start');
  if (await maybeRespawnDaemon(args, resolve(configDir, 'daemon.log'))) return;
  const fullAuto = values['full-auto'] || values['bypass-approvals'];
  const runner = createAgyRunner({ cwd: resolve(values.cwd ?? process.cwd()), agyBin: values['agy-bin'], model: values.model, mode: values.mode as AgyMode | undefined, sandbox: values.sandbox, fullAuto });
  try { await resolveAgyBinary(values['agy-bin']); await runSessionDaemon(runner, { ...clientBranding, configDir, runtime: 'Antigravity', approvalTool: 'agy.approval', fullAuto }); }
  finally { await runner.close(); }
}
