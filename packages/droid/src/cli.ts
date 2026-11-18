import { runInviteConnectCli, inviteDaemonArgs } from '@nia-teams/agent-bridge-core';
import { maybeRespawnDaemon } from '@nia-teams/agent-bridge-core';
import { clientBranding } from './branding.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultConfigDir, loadCredentials, runPairingCli, runSessionDaemon } from '@nia-teams/agent-bridge-core';
import { createDroidRunner, resolveDroidBinary, validateDroidOptions } from './runner.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'invite-code': { type: 'string' }, 'user-name': { type: 'string' }, 'agent-name': { type: 'string' }, 'no-browser': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    daemon: { type: 'boolean' }, 'log-file': { type: 'string' },
    'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, autonomy: { type: 'string' }, 'full-auto': { type: 'boolean' }, 'droid-bin': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length === 0) { console.log('nia-droid connect --invite-code <code> [--user-name <name>] [--agent-name <name>] [--no-browser] [--no-start] [--cwd <dir>] [--daemon] [--log-file <path>]\nnia-droid pair [--server-url <url>] [--config-dir <dir>] [--name <label>]\nnia-droid status [--config-dir <dir>]\nnia-droid start [--daemon] [--log-file <path>] [--config-dir <dir>] [--cwd <dir>] [--model <model>] [--effort <level>] [--autonomy <off|low|medium|high>] [--full-auto] [--droid-bin <path>]'); return; }
  if (positionals.length !== 1) throw new Error('Expected one command');
  validateDroidOptions({ cwd: values.cwd ?? process.cwd(), effort: values.effort, autonomy: values.autonomy });
  const configDir = resolve(values['config-dir'] ?? defaultConfigDir('nia-teams-droid', 'NIA_DROID_CONFIG_DIR'));
  if (positionals[0] === 'connect') {
    if (!values['invite-code']) throw new Error('connect requires --invite-code');
    if (!values['no-start']) {
      await resolveDroidBinary(values['droid-bin']);
    }
    await runInviteConnectCli({ configDir, hostPrefix: 'droid', ...clientBranding,
      inviteCode: values['invite-code'], userName: values['user-name'], agentName: values['agent-name'],
      serverUrl: values['server-url'], hostLabel: values.name, openBrowser: !values['no-browser'] });
    if (!values['no-start']) await maybeRespawnDaemon(inviteDaemonArgs({ ...values, 'config-dir': configDir }), resolve(configDir, 'daemon.log'));
    return;
  }
  if (positionals[0] === 'pair') { await runPairingCli({ configDir, hostPrefix: 'droid', ...clientBranding, cliCommandName: 'nia-droid', serverUrl: values['server-url'], hostLabel: values.name }); return; }
  if (positionals[0] === 'status') { const c = await loadCredentials(configDir); console.log(`Agent: ${c.agentName} (@${c.agentSlug})\nServer: ${c.serverUrl}\nConfig: ${configDir}`); return; }
  if (positionals[0] !== 'start') throw new Error('Unknown command: use pair, status, or start');
  if (await maybeRespawnDaemon(args, resolve(configDir, 'daemon.log'))) return;
  await resolveDroidBinary(values['droid-bin']);

  await runSessionDaemon(createDroidRunner({ cwd: resolve(values.cwd ?? process.cwd()), model: values.model, effort: values.effort, autonomy: values.autonomy, fullAuto: values['full-auto'], droidBin: values['droid-bin'] }), { ...clientBranding, configDir, runtime: 'Factory Droid', approvalTool: 'droid.approval', fullAuto: values['full-auto'] });
}
