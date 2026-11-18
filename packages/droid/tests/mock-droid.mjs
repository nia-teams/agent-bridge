#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AskUserResultSchema } from '@factory/droid-sdk/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const envelope = { jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.269.0' };
const log = data => appendFileSync(join(process.cwd(), 'mock-log.jsonl'), JSON.stringify({ pid: process.pid, ...data }) + '\n');
const emit = data => process.stdout.write(JSON.stringify({ ...envelope, ...data }) + '\n');
const pending = new Map();
let id, config, turnId, settings;
const file = id => join(process.cwd(), `mock-session-${id}.json`);
const notify = notification => emit({ type: 'notification', method: 'droid.session_notification', params: { sessionId: id, notification } });
const complete = (reason = 'completed') => notify({ type: 'agent_turn_completed', turnId, reason, tokenUsage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 } });
const request = (method, params) => new Promise((resolve, reject) => { const rid = randomUUID(); pending.set(rid, { resolve, reject }); emit({ type: 'request', id: rid, method, params }); });
async function mcp(name, args) {
  const server = config.mcpServers.find(s => s.name === 'nia');
  log({ mcp: server });
  const client = new Client({ name: 'mock-droid', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(h => [h.name, h.value])) } }));
    const tools = await client.listTools(); log({ tools });
    const result = await client.callTool({ name, arguments: args }); log({ mcpResult: result });
    if (result.isError) throw new Error(JSON.stringify(result));
    return result;
  } finally { await client.close(); }
}
async function prompt(text) {
  notify({ type: 'assistant_text_delta', messageId: 'private', blockIndex: 0, textDelta: 'PRIVATE ASSISTANT TEXT' });
  notify({ type: 'assistant_text_complete', messageId: 'private', blockIndex: 0 });
  if (text.includes('hold')) return;
  if (text.includes('crash turn')) { process.exit(2); }
  if (text.includes('question')) {
    const questions = text.includes('multi-question')
      ? [{ index: 2, topic: 'Color', question: 'Choose a color', options: ['Blue', 'Red'] }, { index: 5, topic: 'Task', question: 'Describe the task', options: [] }]
      : [{ index: 1, topic: 'Color', question: 'Choose a color', options: ['Blue', 'Red'] }];
    const result = await request('droid.ask_user', { toolCallId: 'question-tool', questions });
    log({ askResult: AskUserResultSchema.parse(result) });
  }
  if (text.includes('permission') || text.includes('collaboration')) {
    const name = text.includes('collaboration future') ? 'mcp__nia__future_tool' : text.includes('collaboration scoped') ? 'send_message' : text.includes('collaboration mcp') ? 'mcp__nia__chat_history' : text.includes('collaboration') ? 'nia___send_message' : text.includes('spoof') ? 'AskUserQuestion' : 'Execute';
    notify({ type: 'tool_call', toolUse: { type: 'tool_use', id: 'exec', name, input: { command: 'echo test' } } });
    const result = await request('droid.request_permission', { toolUses: [{ toolUse: { type: 'tool_use', id: 'exec', name, ...(text.includes('scoped') ? { namespace: 'nia' } : {}), input: { command: 'echo test' } }, confirmationType: 'exec', details: { type: 'exec', fullCommand: 'echo test', command: 'echo test' } }], options: [{ label: "Allow once", value: "proceed_once" }, { label: "Cancel", value: "cancel" }] });
    log({ permissionResult: result });
  }
  if (text.includes('use tools') || text.includes('future tools') || text.includes('system-reminder')) {
    if (text.includes('future tools')) await mcp('future_tool', { value: 'new' });
    await mcp('chat_history', text.includes('default history') ? {} : { limit: 2, offset: 0 });
    await mcp('send_message', { content: 'Droid interim' });
  }
  if (text.includes('fail turn')) complete('error'); else complete();
}
async function handle(frame) {
  log({ frame });
  if (frame.type === 'response') {
    const p = pending.get(frame.id); pending.delete(frame.id);
    if (frame.error) p?.reject(new Error(JSON.stringify(frame.error))); else p?.resolve(frame.result);
    return;
  }
  const reply = result => emit({ type: 'response', id: frame.id, result });
  switch (frame.method) {
    case 'droid.initialize_session':
      id = randomUUID(); config = frame.params;
      settings = { modelId: config.modelId ?? 'mock-model', reasoningEffort: config.reasoningEffort ?? 'medium', autonomyLevel: config.autonomyLevel ?? 'medium', systemPrompt: config.systemPrompt };
      writeFileSync(file(id), JSON.stringify(settings));
      reply({ sessionId: id, session: { messages: [] }, settings }); break;
    case 'droid.load_session':
      id = frame.params.sessionId; config = frame.params;
      if (existsSync(join(process.cwd(),'mock-load-error'))) { emit({ type: 'response', id: frame.id, error: { code: -32603, message: 'Load rejected' } }); break; }
      if (!existsSync(file(id))) { emit({ type: 'response', id: frame.id, error: { code: -32004, message: 'Session missing' } }); break; }
      settings = JSON.parse(readFileSync(file(id), 'utf8'));
      reply({ session: { messages: [] }, settings, cwd: process.cwd() }); break;
    case 'droid.update_session_settings':
      settings = { ...settings, ...frame.params }; writeFileSync(file(id), JSON.stringify(settings)); reply({}); break;
    case 'droid.add_user_message':
      turnId = frame.params.messageId; reply({});
      void prompt(frame.params.text).catch(error => { log({ error: error.stack }); complete('error'); }); break;
    case 'droid.interrupt_session': reply({}); log({ interrupted: true }); complete('cancelled'); break;
    case 'droid.close_session': reply({}); break;
    default: reply({});
  }
}
log({ started: true, argv: process.argv.slice(2), disableUpdate: process.env.DROID_DISABLE_AUTO_UPDATE, hasApiKey: Boolean(process.env.FACTORY_API_KEY) });
createInterface({ input: process.stdin }).on('line', line => { void handle(JSON.parse(line)).catch(error => { log({ error: error.stack }); process.exitCode = 1; }); });
process.on('exit', () => log({ exited: true }));
