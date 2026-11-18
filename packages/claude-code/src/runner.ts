import { spawn } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { consumeSdkQuery, createToolServer, findExecutable, executableCommand, type TurnRunner } from '@nia-teams/agent-bridge-core';
import { homedir } from 'node:os';
import { join } from 'node:path';
export interface ClaudeRunnerOptions { cwd: string; model?: string; fullAuto?: boolean; claudeBin?: string }
export async function resolveClaudeBinary(explicit?: string): Promise<string> {
  return findExecutable('claude', explicit ?? process.env.CLAUDE_BIN, [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']);
}
export function createClaudeRunner(options: ClaudeRunnerOptions): TurnRunner {
  return async context => {
    const binary = await resolveClaudeBinary(options.claudeBin);
    context.signal.throwIfAborted();
    const controller = new AbortController(); const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort();
    const server = { type: 'sdk' as const, name: 'nia', instance: createToolServer(context, true) };
    try {
      return await consumeSdkQuery(query({ prompt: context.prompt, options: {
        // The SDK recognizes .js/.mjs itself; its hook handles custom batch
        // wrappers and .cjs without handing either to the wrong interpreter.
        ...(/\.(?:cmd|bat|cjs)$/i.test(binary) ? { spawnClaudeCodeProcess: (options: import('@anthropic-ai/claude-agent-sdk').SpawnOptions) => {
          const command = executableCommand(binary, options.args);
          return spawn(command.file, command.args, { ...command.options, cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
        } } : {}),
        pathToClaudeCodeExecutable: binary, cwd: options.cwd, model: options.model, resume: context.resume,
        abortController: controller, permissionMode: options.fullAuto ? 'bypassPermissions' : 'default', allowDangerouslySkipPermissions: Boolean(options.fullAuto),
        settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code', append: context.systemPrompt },
        mcpServers: { nia: server as unknown as import('@anthropic-ai/claude-agent-sdk').McpSdkServerConfigWithInstance }, strictMcpConfig: true,
        canUseTool: async (name, input, detail) => {
          // Collaboration tools own their server-side authorization and confirmations.
          if (name.startsWith('mcp__nia__')) return { behavior: 'allow', updatedInput: input };
          const result = await context.permission(name, input, detail.signal);
          return result.behavior === 'allow' ? { behavior: 'allow', updatedInput: result.updatedInput ?? input } : { behavior: 'deny', message: result.message ?? 'Denied' };
        }, stderr: data => process.stderr.write(data),
      } }), context);
    } finally { context.signal.removeEventListener('abort', abort); await server.instance.close(); }
  };
}
