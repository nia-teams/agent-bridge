import { spawn } from 'node:child_process';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { consumeSdkQuery, GROUP_CHAT_INSTRUCTIONS, findExecutable, executableCommand, type TurnRunner } from '@nia-teams/agent-bridge-core';
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
    const server = createSdkMcpServer({ name: 'nia', version: '0.1.0', tools: [
      tool('nia_group_chat_send_message', 'Send an interim update to this GroupChat', { content: z.string().trim().min(1) }, async ({ content }) => { await context.send(content); return { content: [{ type: 'text', text: 'Sent' }] }; }),
      tool('nia_group_chat_history', 'Read older messages in this GroupChat', { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }, async ({ limit, offset }) => ({ content: [{ type: 'text', text: JSON.stringify(await context.history(limit, offset)) }] })),
    ] });
    try {
      return await consumeSdkQuery(query({ prompt: context.prompt, options: {
        // The SDK recognizes .js/.mjs itself; its hook handles custom batch
        // wrappers and .cjs without handing either to the wrong interpreter.
        ...(/\.(?:cmd|bat|cjs)$/i.test(binary) ? { spawnClaudeCodeProcess: (options: import('@anthropic-ai/claude-agent-sdk').SpawnOptions) => {
          const command = executableCommand(binary, options.args);
          return spawn(command.file, command.args, { ...command.options, cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
        } } : {}),
        pathToClaudeCodeExecutable: binary, cwd: options.cwd, model: options.model, resume: context.resume,
        // User/project settings may launch the legacy channel plugin. Its child
        // must not acquire a second bridge connection and supersede this daemon.
        env: { ...process.env, NIA_CLAUDE_DAEMON: '1' },
        abortController: controller, permissionMode: options.fullAuto ? 'bypassPermissions' : 'default', allowDangerouslySkipPermissions: Boolean(options.fullAuto),
        settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code', append: GROUP_CHAT_INSTRUCTIONS },
        mcpServers: { nia: server }, strictMcpConfig: true,
        canUseTool: async (name, input, detail) => {
          // These two scoped collaboration tools need no separate TaskBar approval.
          if (name === 'mcp__nia__nia_group_chat_send_message' || name === 'mcp__nia__nia_group_chat_history') return { behavior: 'allow', updatedInput: input };
          const result = await context.permission(name, input, detail.signal);
          return result.behavior === 'allow' ? { behavior: 'allow', updatedInput: result.updatedInput ?? input } : { behavior: 'deny', message: result.message ?? 'Denied' };
        }, stderr: data => process.stderr.write(data),
      } }), context);
    } finally { context.signal.removeEventListener('abort', abort); await server.instance.close(); }
  };
}
