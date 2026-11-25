import { runConnectCli, connectDaemonArgs } from '@nia-teams/agent-bridge-core';
import { maybeRespawnDaemon } from '@nia-teams/agent-bridge-core';
import { clientBranding } from './branding.js';
import { resolve } from 'node:path';
import { defaultConfigDir } from './credentials.js';
import { runSessionDaemon } from '@nia-teams/agent-bridge-core';
import { parseArgs } from 'node:util';
import { loadCredentials } from './credentials.js';
import { acquireLease, runPairingCli } from './pairing.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'group-link': { type: 'string' }, 'agent-name': { type: 'string' }, 'no-browser': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    daemon: { type: 'boolean' }, 'log-file': { type: 'string' },
    cwd: { type: 'string' }, model: { type: 'string' }, 'full-auto': { type: 'boolean' }, 'claude-bin': { type: 'string' }, name: { type: 'string' }, server: { type: 'string' }, 'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, label: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length === 0) {
    console.log('nia-claude connect [--group-link <url-or-token>] [--agent-name <name>] [--server-url <origin>] [--config-dir <dir>] [--label <label>] [--no-browser] [--no-start] [--cwd <dir>] [--daemon] [--log-file <path>]\nnia-claude pair [--server-url <url>] [--config-dir <dir>] [--name <label>] [--timeout-ms <ms>]\nnia-claude start [--daemon] [--log-file <path>] [--config-dir <dir>] [--cwd <dir>] [--model <model>] [--full-auto] [--claude-bin <path>]\nnia-claude status [--config-dir <dir>]');
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected one command: connect, pair, status, or start');
  if (positionals[0] === 'connect') {
    if (!values['no-start']) {
      const { resolveClaudeBinary } = await import('./runner.js');
      await resolveClaudeBinary(values['claude-bin']);
    }
    await runConnectCli({ configDir: resolve(values['config-dir'] ?? defaultConfigDir()), hostPrefix: 'claude-code', ...clientBranding,
      groupLink: values['group-link'], agentName: values['agent-name'],
      serverUrl: values['server-url'] ?? values.server, hostLabel: values.name ?? values.label, openBrowser: !values['no-browser'] });
    if (!values['no-start']) await maybeRespawnDaemon(connectDaemonArgs({ ...values, 'config-dir': resolve(values['config-dir'] ?? defaultConfigDir()) }), resolve(resolve(values['config-dir'] ?? defaultConfigDir()), 'daemon.log'));
    return;
  }
  if (positionals[0] === 'pair') {
    await runPairingCli({ serverUrl: values['server-url'] ?? values.server, configDir: values['config-dir'], hostLabel: values.name ?? values.label,
      timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
    });
  } else if (positionals[0] === 'start') {
    if (await maybeRespawnDaemon(args, resolve(values['config-dir'] ?? defaultConfigDir(), 'daemon.log'))) return;
    const { createClaudeRunner, resolveClaudeBinary } = await import('./runner.js');
    await resolveClaudeBinary(values['claude-bin']);
    const cwd = resolve(values.cwd ?? process.cwd());
    await runSessionDaemon(createClaudeRunner({ cwd, model: values.model, fullAuto: values['full-auto'], claudeBin: values['claude-bin'] }), {
      ...clientBranding, configDir: resolve(values['config-dir'] ?? defaultConfigDir()), cwd, runtime: 'Claude Code', approvalTool: 'claude_code.permission', fullAuto: values['full-auto'],
    });
  } else if (positionals[0] === 'status') {
    const credentials = await loadCredentials(values['config-dir']);
    console.log(`Agent: ${credentials.agentName} (@${credentials.agentSlug})\nServer: ${credentials.serverUrl}\nTeam: ${credentials.teamId}\nKey generation: ${credentials.keyGeneration}\nConfig: ${values['config-dir'] ?? defaultConfigDir()}`);
    await acquireLease(credentials);
    console.log('Challenge/lease authentication: OK');
  } else throw new Error('Unknown command; use nia-claude connect, pair, status, or start');
}
