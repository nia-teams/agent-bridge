import { defaultConfigDir } from './credentials.js';
import { clientBranding } from './branding.js';
import { runConnectCli } from '@nia-teams/agent-bridge-core';
import { parseArgs } from 'node:util';
import { loadCredentials } from './credentials.js';
import { acquireLease, runPairingCli } from './pairing.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'group-link': { type: 'string' }, 'agent-name': { type: 'string' }, 'no-browser': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    server: { type: 'string' }, 'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, label: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length === 0) {
    console.log('nia-dsh connect [--group-link <url-or-token>] [--agent-name <name>] [--server-url <origin>] [--config-dir <dir>] [--label <label>] [--no-browser] [--no-start]\nnia-dsh pair [--server-url <url>] [--config-dir <dir>] [--label <label>] [--timeout-ms <ms>]\nnia-dsh status [--config-dir <dir>]');
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected one command: connect, pair, or status');
  if (positionals[0] === 'connect') {
    await runConnectCli({ configDir: values['config-dir'] ?? defaultConfigDir(), hostPrefix: 'dsh', ...clientBranding,
      groupLink: values['group-link'], agentName: values['agent-name'],
      serverUrl: values['server-url'] ?? values.server, hostLabel: values.label, openBrowser: !values['no-browser'] });
    if (!values['no-start']) console.log('Start the host with: dsh web');
    return;
  }
  if (positionals[0] === 'pair') {
    await runPairingCli({ serverUrl: values['server-url'] ?? values.server, configDir: values['config-dir'], hostLabel: values.label,
      timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
    });
  } else if (positionals[0] === 'status') {
    const credentials = await loadCredentials(values['config-dir']);
    console.log(`Agent: ${credentials.agentName} (@${credentials.agentSlug})\nServer: ${credentials.serverUrl}\nTeam: ${credentials.teamId}\nKey generation: ${credentials.keyGeneration}`);
    await acquireLease(credentials);
    console.log('Challenge/lease authentication: OK');
  } else throw new Error('Unknown command; use nia-dsh connect, pair, or status');
}
