import { maybeRespawnDaemon } from '@nia-teams/agent-bridge-core';
import { clientBranding } from './branding.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultConfigDir, loadCredentials, runPairingCli, runSessionDaemon } from '@nia-teams/agent-bridge-core';
import { createDoubaoRunner, type DoubaoPlatform } from './runner.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    daemon: { type: 'boolean' }, 'log-file': { type: 'string' },
    'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' }, model: { type: 'string' }, 'full-auto': { type: 'boolean' }, 'doubao-bin': { type: 'string' }, platform: { type: 'string' }, runtime: { type: 'string' }, 'restart-app': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length === 0) { console.log('nia-doubao pair [--server-url <url>] [--config-dir <dir>] [--name <label>]\nnia-doubao status [--config-dir <dir>]\nnia-doubao start [--daemon] [--log-file <path>] [--config-dir <dir>] [--cwd <dir>] [--model <model>] [--platform auto|work|doubao|cli|headless] [--runtime local|cloud] [--full-auto] [--restart-app] [--doubao-bin <official-binary>]'); return; }
  if (positionals.length !== 1) throw new Error('Expected one command');
  const configDir = resolve(values['config-dir'] ?? defaultConfigDir('nia-teams-doubao', 'NIA_DOUBAO_CONFIG_DIR'));
  if (positionals[0] === 'pair') { await runPairingCli({ configDir, hostPrefix: 'doubao', ...clientBranding, cliCommandName: 'nia-doubao', serverUrl: values['server-url'], hostLabel: values.name }); return; }
  if (positionals[0] === 'status') { const c = await loadCredentials(configDir); console.log(`Agent: ${c.agentName} (@${c.agentSlug})\nServer: ${c.serverUrl}\nConfig: ${configDir}`); return; }
  if (positionals[0] !== 'start') throw new Error('Unknown command: use pair, status, or start');
  if (await maybeRespawnDaemon(args, resolve(configDir, 'daemon.log'))) return;
  if (values.platform && !['auto', 'work', 'doubao', 'cli', 'headless'].includes(values.platform)) throw new Error('--platform must be auto, work, doubao, cli, or headless');
  if (values.runtime && !['local', 'cloud'].includes(values.runtime)) throw new Error('--runtime must be local or cloud');
  const runner = createDoubaoRunner({ cwd: resolve(values.cwd ?? process.cwd()), model: values.model, fullAuto: values['full-auto'],
    doubaoBin: values['doubao-bin'], platform: values.platform as DoubaoPlatform | undefined, runtime: values.runtime as 'local' | 'cloud' | undefined, restartApp: values['restart-app'] });
  await runner.ready();
  await runSessionDaemon(runner, { ...clientBranding, configDir, runtime: 'Doubao', approvalTool: 'doubao.approval', fullAuto: values['full-auto'] });
}
