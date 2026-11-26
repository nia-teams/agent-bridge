import { runConnectCli, connectDaemonArgs } from '@nia-teams/agent-bridge-core';
import { maybeRespawnDaemon } from '@nia-teams/agent-bridge-core';
import { clientBranding } from './branding.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultConfigDir, loadCredentials, runPairingCli, runSessionDaemon } from '@nia-teams/agent-bridge-core';
import { createDoubaoRunner, type DoubaoPlatform } from './runner.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'group-link': { type: 'string' }, 'agent-name': { type: 'string' }, 'no-browser': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    daemon: { type: 'boolean' }, 'log-file': { type: 'string' },
    'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, name: { type: 'string' }, label: { type: 'string' }, cwd: { type: 'string' }, model: { type: 'string' }, 'require-approval': { type: 'boolean' }, 'full-auto': { type: 'boolean' }, 'doubao-bin': { type: 'string' }, platform: { type: 'string' }, runtime: { type: 'string' }, 'restart-app': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values['require-approval'] && values['full-auto']) throw new Error('--require-approval cannot be combined with --full-auto');
  const fullAuto = !values['require-approval'];
  if (values.help || positionals.length === 0) { console.log('nia-doubao connect [--group-link <url-or-token>] [--agent-name <name>] [--server-url <origin>] [--config-dir <dir>] [--label <label>] [--no-browser] [--no-start] [--cwd <dir>] [--require-approval] [--daemon] [--log-file <path>]\nnia-doubao pair [--server-url <url>] [--config-dir <dir>] [--name <label>]\nnia-doubao status [--config-dir <dir>]\nnia-doubao start [--daemon] [--log-file <path>] [--config-dir <dir>] [--cwd <dir>] [--model <model>] [--platform auto|work|doubao|cli|headless] [--runtime local|cloud] [--require-approval] [--restart-app] [--doubao-bin <official-binary>]\nFull-auto is the default; --full-auto is accepted for compatibility. --require-approval uses Doubao runtime permissions (no TaskBar cards).'); return; }
  if (positionals.length !== 1) throw new Error('Expected one command');
  const configDir = resolve(values['config-dir'] ?? defaultConfigDir('nia-teams-doubao', 'NIA_DOUBAO_CONFIG_DIR'));
  if (positionals[0] === 'connect') {
    if (!values['no-start']) {
      if (values.platform && !['auto', 'work', 'doubao', 'cli', 'headless'].includes(values.platform)) throw new Error('Invalid --platform');
      if (values.runtime && !['local', 'cloud'].includes(values.runtime)) throw new Error('Invalid --runtime');
      await createDoubaoRunner({ cwd: resolve(values.cwd ?? process.cwd()), doubaoBin: values['doubao-bin'], platform: values.platform as DoubaoPlatform | undefined, runtime: values.runtime as 'local' | 'cloud' | undefined, restartApp: values['restart-app'], fullAuto }).ready();
    }
    await runConnectCli({ configDir, hostPrefix: 'doubao', ...clientBranding,
      groupLink: values['group-link'], agentName: values['agent-name'],
      serverUrl: values['server-url'], hostLabel: values.name ?? values.label, openBrowser: !values['no-browser'] });
    if (!values['no-start']) await maybeRespawnDaemon(connectDaemonArgs({ ...values, 'config-dir': configDir }), resolve(configDir, 'daemon.log'));
    return;
  }
  if (positionals[0] === 'pair') { await runPairingCli({ configDir, hostPrefix: 'doubao', ...clientBranding, cliCommandName: 'nia-doubao', serverUrl: values['server-url'], hostLabel: values.name }); return; }
  if (positionals[0] === 'status') { const c = await loadCredentials(configDir); console.log(`Agent: ${c.agentName} (@${c.agentSlug})\nServer: ${c.serverUrl}\nConfig: ${configDir}`); return; }
  if (positionals[0] !== 'start') throw new Error('Unknown command: use pair, status, or start');
  if (await maybeRespawnDaemon(args, resolve(configDir, 'daemon.log'))) return;
  if (values.platform && !['auto', 'work', 'doubao', 'cli', 'headless'].includes(values.platform)) throw new Error('--platform must be auto, work, doubao, cli, or headless');
  if (values.runtime && !['local', 'cloud'].includes(values.runtime)) throw new Error('--runtime must be local or cloud');
  const cwd = resolve(values.cwd ?? process.cwd());
  const runner = createDoubaoRunner({ cwd, model: values.model, fullAuto,
    doubaoBin: values['doubao-bin'], platform: values.platform as DoubaoPlatform | undefined, runtime: values.runtime as 'local' | 'cloud' | undefined, restartApp: values['restart-app'] });
  await runner.ready();
  await runSessionDaemon(runner, { ...clientBranding, configDir, cwd, runtime: 'Doubao', approvalTool: 'doubao.approval', fullAuto });
}
