import { createSession, resumeSession, ProcessTransport, AutonomyLevel, ReasoningEffort, ToolConfirmationOutcome, SessionNotFoundError, type DroidSession, type CreateSessionOptions } from '@factory/droid-sdk/node';
import { ToolHttpServer, findExecutable, type TurnRunner } from '@nia-teams/agent-bridge-core';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DroidOptions { cwd: string; model?: string; effort?: string; autonomy?: string; fullAuto?: boolean; droidBin?: string }
export function validateDroidOptions(options: DroidOptions): void {
  if (options.effort !== undefined && !Object.values(ReasoningEffort).includes(options.effort as ReasoningEffort)) throw new Error('Invalid --effort: use none, dynamic, off, minimal, low, medium, high, xhigh, or max');
  if (options.autonomy !== undefined && !Object.values(AutonomyLevel).includes(options.autonomy as AutonomyLevel)) throw new Error('Invalid --autonomy: use off, low, medium, or high');
}
export async function resolveDroidBinary(explicit?: string): Promise<string> {
  const binary = await findExecutable('droid', explicit ?? process.env.DROID_BIN, [
    join(homedir(), '.local/bin/droid'), join(homedir(), '.factory/bin/droid'), '/opt/homebrew/bin/droid', '/usr/local/bin/droid',
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/droid/droid.exe'), join(homedir(), '.local/bin/droid.exe')] : []),
  ]);
  // ProcessTransport spawns the entrypoint itself, without a shell or Node prefix.
  if (/\.(?:cmd|bat)$/i.test(binary) || (process.platform === 'win32' && /\.(?:mjs|cjs|js)$/i.test(binary))) throw new Error('Droid SDK requires a native executable on Windows; pass --droid-bin with droid.exe, not an npm shim');
  if (process.platform !== 'win32') {
    try { await access(binary, constants.X_OK); } catch { throw new Error(`Droid SDK executes scripts as programs; make ${binary} executable with a Node shebang, or select the native droid binary`); }
  }
  return binary;
}
export function createDroidRunner(options: DroidOptions): TurnRunner {
  validateDroidOptions(options);
  const fullAuto = options.fullAuto ?? true;
  return async context => {
    const binary = await resolveDroidBinary(options.droidBin);
    context.signal.throwIfAborted();
    const server = new ToolHttpServer(context);
    const endpoint = await server.start();
    const mcpConfig = { type: 'http' as const, name: 'nia', url: endpoint.url, headers: Object.entries(endpoint.headers).map(([name, value]) => ({ name, value })) };
    let transport: ProcessTransport | undefined, session: DroidSession | undefined;
    const settings = { ...(options.model !== undefined ? { modelId: options.model } : {}), ...(options.effort !== undefined ? { reasoningEffort: options.effort as ReasoningEffort } : {}), ...(options.autonomy !== undefined ? { autonomyLevel: options.autonomy as AutonomyLevel } : fullAuto ? { autonomyLevel: AutonomyLevel.High } : {}) };
    const handlers: Pick<CreateSessionOptions, 'permissionHandler' | 'askUserHandler'> = {
      permissionHandler: async params => {
        for (const entry of params.toolUses) {
          const { name, namespace, input } = entry.toolUse;
          const collaboration = namespace === 'nia' || name.startsWith('nia___') || name.startsWith('mcp__nia__');
          if (collaboration) continue;
          if (context.signal.aborted) return { selectedOption: ToolConfirmationOutcome.Cancel };
          if (fullAuto) continue;
          const decision = await context.permission(`droid:${namespace ? `${namespace}:` : ''}${name}`, { input, confirmationType: entry.confirmationType, details: entry.details }, context.signal);
          if (decision.behavior !== 'allow') return { selectedOption: ToolConfirmationOutcome.Cancel };
        }
        return { selectedOption: ToolConfirmationOutcome.ProceedOnce };
      },
      askUserHandler: async params => {
        if (context.signal.aborted) return { cancelled: true, answers: [] };
        const decision = await context.permission('AskUserQuestion', { questions: params.questions.map(q => ({ question: q.question, options: q.options.map(label => ({ label })), multiSelect: q.multiSelect })) }, context.signal);
        const answers = decision.updatedInput?.answers;
        if (decision.behavior !== 'allow' || !answers || typeof answers !== 'object' || context.signal.aborted) return { cancelled: true, answers: [] };
        return { answers: params.questions.map(q => ({ index: q.index, question: q.question, answer: String((answers as Record<string, unknown>)[q.question] ?? '') })) };
      },
    };
    const connect = async () => {
      context.signal.throwIfAborted();
      transport = new ProcessTransport({ droidExecPath: binary, cwd: options.cwd, env: Object.fromEntries(Object.entries({ ...process.env, DROID_DISABLE_AUTO_UPDATE: 'true' }).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
      await transport.connect();
      return { transport, ...handlers, mcpServers: [mcpConfig], abortSignal: context.signal };
    };
    try {
      const config = await connect();
      if (context.resume) {
        try { session = await resumeSession(context.resume, config); }
        catch (error) {
          // Only a missing persisted session permits a fresh session, before a prompt.
          if (!(error instanceof SessionNotFoundError)) throw error;
          await transport!.close();
          session = await createSession({ ...await connect(), cwd: options.cwd, ...settings, systemPrompt: { type: 'preset', preset: 'droid', append: context.systemPrompt } });
        }
      } else session = await createSession({ ...config, cwd: options.cwd, ...settings, systemPrompt: { type: 'preset', preset: 'droid', append: context.systemPrompt } });
      await context.session(session.id);
      if (context.resume && Object.keys(settings).length) await session.updateSettings(settings);
      let result = false;
      for await (const event of session.stream(context.prompt, { abortSignal: context.signal })) {
        if (event.type === 'tool_call') await context.activity('executing', `Using ${event.name ?? 'tool'}…`);
        if (event.type === 'result') {
          result = true;
          if (!event.success || event.subtype !== 'success') throw new Error(event.error?.message || `Droid turn failed: ${event.subtype}`);
        }
      }
      context.signal.throwIfAborted();
      if (!result) throw new Error('Droid stream ended without a result');
    } finally {
      // Session.close currently closes external transports too; explicit ownership
      // also covers connect/initialization failures and future SDK behavior.
      try { await session?.close(); } finally { try { await transport?.close(); } finally { await server.close(); } }
    }
  };
}
