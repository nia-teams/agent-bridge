import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultConfigDir, connectDaemonArgs, loadCredentials, maybeRespawnDaemon, runConnectCli, runPairingCli, runSessionDaemon } from '@nia-teams/agent-bridge-core';
import { PI_BRANDING } from './branding.js';
import { createPiRunner, resolvePiBinary, validatePiOptions } from './runner.js';

const usage = `nia-pi status [--config-dir <dir>]
nia-pi pair [--name <label>] [--server-url <url>] [--config-dir <dir>]
nia-pi connect [--group-link <url-or-token>] [--agent-name <name>] [--server-url <origin>] [--config-dir <dir>] [--label <label>] [--no-browser] [--no-start] [start options]
nia-pi start [--cwd <dir>] [--daemon] [--log-file <path>] [--config-dir <dir>] [--model <model>] [--provider <provider>] [--thinking <level>] [--pi-bin <path>]`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, 'config-dir': { type: 'string' }, 'server-url': { type: 'string' }, name: { type: 'string' },
    'group-link': { type: 'string' }, label: { type: 'string' }, 'agent-name': { type: 'string' }, 'no-browser': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    cwd: { type: 'string' }, daemon: { type: 'boolean' }, 'log-file': { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' }, thinking: { type: 'string' }, 'pi-bin': { type: 'string' },
  } });
  if (values.help || positionals.length === 0) { console.log(usage); return; }
  if (positionals.length !== 1) throw new Error('Expected one command');
  const configDir = resolve(values['config-dir'] ?? defaultConfigDir('nia-teams-pi', 'NIA_PI_CONFIG_DIR'));
  const runtime = { cwd: resolve(values.cwd ?? process.cwd()), configDir, model: values.model, provider: values.provider, thinking: values.thinking, piBin: values['pi-bin'] };
  validatePiOptions(runtime);
  const identity = { ...PI_BRANDING, configDir, hostPrefix: 'pi', serverUrl: values['server-url'], hostLabel: values.name };
  const log = resolve(configDir, 'daemon.log');
  switch (positionals[0]) {
    case 'status': {
      const credentials = await loadCredentials(configDir);
      console.log(`Agent: ${credentials.agentName} (@${credentials.agentSlug})\nServer: ${credentials.serverUrl}\nConfig: ${configDir}`);
      return;
    }
    case 'pair':
      await runPairingCli({ ...identity, cliCommandName: 'nia-pi' });
      return;
    case 'connect':
      if (!values['no-start']) await resolvePiBinary(runtime.piBin);
      await runConnectCli({ ...identity, groupLink: values['group-link'], hostLabel: values.name ?? values.label, agentName: values['agent-name'], openBrowser: !values['no-browser'] });
      if (!values['no-start']) await maybeRespawnDaemon(connectDaemonArgs({ ...values, 'config-dir': configDir }), log);
      return;
    case 'start':
      runtime.piBin = await resolvePiBinary(runtime.piBin);
      if (await maybeRespawnDaemon(args, log)) return;
      await runSessionDaemon(createPiRunner(runtime), { ...PI_BRANDING, configDir, cwd: runtime.cwd, runtime: 'Pi', approvalTool: 'pi.approval' });
      return;
    default: throw new Error('Unknown command: use status, pair, connect, or start');
  }
}
