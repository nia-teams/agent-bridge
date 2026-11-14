import { runInviteConnectCli, inviteDaemonArgs } from '@nia-teams/agent-bridge-core';
import { maybeRespawnDaemon } from '@nia-teams/agent-bridge-core';
import { clientBranding } from './branding.js';
import { runStdioServer } from './stdio.js';
import { resolve } from 'node:path';
import { defaultConfigDir } from './credentials.js';
import { runSessionDaemon } from '@nia-teams/agent-bridge-core';
import { parseArgs } from 'node:util';
import { loadCredentials } from './credentials.js';
import { acquireLease, runPairingCli } from './pairing.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'invite-code': { type: 'string' }, 'user-name': { type: 'string' }, 'agent-name': { type: 'string' }, 'no-browser': { type: 'boolean' }, 'no-start': { type: 'boolean' },
    daemon: { type: 'boolean' }, 'log-file': { type: 'string' },
    cwd: { type: 'string' }, model: { type: 'string' }, 'full-auto': { type: 'boolean' }, 'claude-bin': { type: 'string' }, name: { type: 'string' }, server: { type: 'string' }, 'server-url': { type: 'string' }, 'config-dir': { type: 'string' }, label: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length === 0) {
    console.log('nia-claude connect --invite-code <code> [--user-name <name>] [--agent-name <name>] [--no-browser] [--no-start] [--cwd <dir>] [--daemon] [--log-file <path>]\nnia-claude pair [--server-url <url>] [--config-dir <dir>] [--label <label>] [--timeout-ms <ms>]\nnia-claude start [--daemon] [--log-file <path>] [--config-dir <dir>] [--cwd <dir>] [--model <model>] [--full-auto] [--claude-bin <path>]\nnia-claude status [--config-dir <dir>]\nnia-claude mcp [--config-dir <dir>]');
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected one command: pair, status, start, or mcp');
  if (positionals[0] === 'connect') {
    if (!values['invite-code']) throw new Error('connect requires --invite-code');
    if (!values['no-start']) {
      const { resolveClaudeBinary } = await import('./runner.js');
      await resolveClaudeBinary(values['claude-bin']);
    }
    await runInviteConnectCli({ configDir: resolve(values['config-dir'] ?? defaultConfigDir()), hostPrefix: 'claude-code', ...clientBranding,
      inviteCode: values['invite-code'], userName: values['user-name'], agentName: values['agent-name'],
      serverUrl: values['server-url'] ?? values.server, hostLabel: values.name ?? values.label, openBrowser: !values['no-browser'] });
    if (!values['no-start']) await maybeRespawnDaemon(inviteDaemonArgs({ ...values, 'config-dir': resolve(values['config-dir'] ?? defaultConfigDir()) }), resolve(resolve(values['config-dir'] ?? defaultConfigDir()), 'daemon.log'));
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
    await runSessionDaemon(createClaudeRunner({ cwd: resolve(values.cwd ?? process.cwd()), model: values.model, fullAuto: values['full-auto'], claudeBin: values['claude-bin'] }), {
      ...clientBranding, configDir: resolve(values['config-dir'] ?? defaultConfigDir()), runtime: 'Claude Code', approvalTool: 'claude_code.permission', fullAuto: values['full-auto'],
    });
  } else if (positionals[0] === 'mcp') {
    await runStdioServer(values['config-dir']);
  } else if (positionals[0] === 'status') {
    const credentials = await loadCredentials(values['config-dir']);
    console.log(`Agent: ${credentials.agentName} (@${credentials.agentSlug})\nServer: ${credentials.serverUrl}\nTeam: ${credentials.teamId}\nKey generation: ${credentials.keyGeneration}\nConfig: ${values['config-dir'] ?? defaultConfigDir()}`);
    await acquireLease(credentials);
    console.log('Challenge/lease authentication: OK');
  } else throw new Error('Unknown command; use nia-claude pair, status, or mcp');
}
