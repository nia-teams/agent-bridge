#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const log = value => { if (process.env.NIA_MOCK_LOG) appendFileSync(process.env.NIA_MOCK_LOG, JSON.stringify(value) + '\n'); };
log({ kind: 'spawn', args });
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const flag = name => { const i = args.indexOf(name); return i < 0 ? args.find(a => a.startsWith(name + '='))?.slice(name.length + 1) : args[i+1]; };
const session = flag('--resume') ?? randomUUID();
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
let prompt = '', next = 0; const pending = new Map();
const request = payload => new Promise(resolve => { const id = `mock-${++next}`; pending.set(id, resolve); send({ type: 'control_request', request_id: id, request: payload }); });
const mcp = async (method, params, id = ++next) => {
 const r = await request({ subtype: 'mcp_message', server_name: 'nia', message: { jsonrpc: '2.0', id, method, params } });
 return r.mcp_response;
};
async function turn() {
 send({ type: 'system', subtype: 'init', session_id: session, uuid: randomUUID(), tools: [], mcp_servers: [], cwd: process.cwd() });
 if (prompt.includes('hold')) return;
 if (prompt.includes('permission') || prompt.includes('question')) {
  const question = prompt.includes('question');
  const result = await request({ subtype: 'can_use_tool', tool_name: question ? 'AskUserQuestion' : 'Bash', input: question ? { questions: [{ question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }] }] } : { command: 'ls -la' }, tool_use_id: 'mock-tool-1', permission_suggestions: [] });
  log({ kind: 'permission', result });
 }
 if (prompt.includes('tools')) {
  await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock', version: '1' } });
  await request({ subtype: 'mcp_message', server_name: 'nia', message: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  log({ kind: 'history', result: await mcp('tools/call', { name: 'nia_group_chat_history', arguments: { limit: 3 } }) });
  log({ kind: 'send', result: await mcp('tools/call', { name: 'nia_group_chat_send_message', arguments: { content: 'SDK interim' } }) });
 }
 send({ type: 'assistant', session_id: session, parent_tool_use_id: null, uuid: randomUUID(), message: { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'SDK final reply' }], model: 'mock', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
 send({ type: 'result', subtype: 'success', is_error: false, session_id: session, uuid: randomUUID(), result: 'SDK final reply', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
}
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); log({ kind: 'in', message: m });
 if (m.type === 'control_response') { const r = m.response; pending.get(r.request_id)?.(r.response ?? {}); pending.delete(r.request_id); }
 if (m.type === 'control_request' && m.request.subtype === 'interrupt') { send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: '', uuid: randomUUID() }); setTimeout(() => process.exit(0), 20); }
 if (m.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {}, ...(m.request.subtype === 'initialize' ? { supportedCommands: [], supportedModels: [] } : {}) } } });
 if (m.type === 'user') { prompt = typeof m.message.content === 'string' ? m.message.content : m.message.content.map(b => b.text ?? '').join('\n'); void turn().catch(e => { console.error(e); process.exit(1); }); }
});
