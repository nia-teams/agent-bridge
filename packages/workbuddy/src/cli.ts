import { maybeRespawnDaemon } from '@nia-teams/agent-bridge-core';
import { clientBranding } from './branding.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultConfigDir, loadCredentials, runPairingCli, runSessionDaemon } from '@nia-teams/agent-bridge-core';
import { createWorkBuddyRunner, resolveCodeBuddyBinary } from './runner.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    daemon: { type: 'boolean' }, 'log-file': { type: 'string' },
    'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' }, model: { type: 'string' }, 'full-auto': { type: 'boolean' }, 'codebuddy-bin': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length === 0) { console.log('nia-workbuddy pair [--server-url <url>] [--config-dir <dir>] [--name <label>]\nnia-workbuddy status [--config-dir <dir>]\nnia-workbuddy start [--daemon] [--log-file <path>] [--config-dir <dir>] [--cwd <dir>] [--model <model>] [--full-auto] [--codebuddy-bin <path>]'); return; }
  if (positionals.length !== 1) throw new Error('Expected one command');
  const configDir = resolve(values['config-dir'] ?? defaultConfigDir('nia-teams-workbuddy', 'NIA_WORKBUDDY_CONFIG_DIR'));
  if (positionals[0] === 'pair') { await runPairingCli({ configDir, hostPrefix: 'workbuddy', ...clientBranding, cliCommandName: 'nia-workbuddy', serverUrl: values['server-url'], hostLabel: values.name }); return; }
  if (positionals[0] === 'status') { const c = await loadCredentials(configDir); console.log(`Agent: ${c.agentName} (@${c.agentSlug})\nServer: ${c.serverUrl}\nConfig: ${configDir}`); return; }
  if (positionals[0] !== 'start') throw new Error('Unknown command: use pair, status, or start');
  if (await maybeRespawnDaemon(args, resolve(configDir, 'daemon.log'))) return;
  await resolveCodeBuddyBinary(values['codebuddy-bin']);

  await runSessionDaemon(createWorkBuddyRunner({ cwd: resolve(values.cwd ?? process.cwd()), model: values.model, fullAuto: values['full-auto'], codebuddyBin: values['codebuddy-bin'] }), { ...clientBranding, configDir, runtime: 'WorkBuddy', approvalTool: 'workbuddy.approval', fullAuto: values['full-auto'] });
}
