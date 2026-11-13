#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const log = value => { if (process.env.AGY_TEST_LOG) appendFileSync(process.env.AGY_TEST_LOG, JSON.stringify({ pid: process.pid, ...value }) + '\n'); };
log({ kind: 'spawn', args: process.argv.slice(2) });
const sessions = new Map(), pending = new Map(), held = new Map(); let serverId = 0;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (id, value) => send({ id, result: value });
const update = (sid, value) => send({ method: 'session/update', params: { sessionId: sid, update: value } });
const finish = (id, sid, text = 'Hello from Antigravity') => {
  for (const textPart of [text.slice(0, 7), text.slice(7)]) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textPart } });
  result(id, { stopReason: 'end_turn', usage: { inputTokens: 9, outputTokens: 3 } });
};
async function request(m) {
  log({ kind: 'request', method: m.method, params: m.params }); const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      if (process.env.AGY_TEST_INIT === 'hang') return;
      if (process.env.AGY_TEST_INIT === 'malformed') { process.stdout.write('not json\n'); return; }
      if (process.env.AGY_TEST_INIT === 'wrong-version') return result(m.id, { protocolVersion: 2 });
      return result(m.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: true } }, agentInfo: { name: 'mock-acp' }, authMethods: [] });
    case 'session/new': {
      if (process.env.AGY_TEST_NEW === 'missing-id') return result(m.id, {});
      const sid = randomUUID(); sessions.set(sid, p); return result(m.id, { sessionId: sid, models: { availableModels: [] }, modes: { currentModeId: 'default' } });
    }
    case 'session/resume':
      if (process.env.AGY_TEST_RESUME === 'crash') process.exit(7);
      if (process.env.AGY_TEST_RESUME === 'error' || !sessions.has(p.sessionId)) return send({ id: m.id, error: { code: -32002, message: 'Session missing' } });
      sessions.set(p.sessionId, p); return result(m.id, { sessionId: process.env.AGY_TEST_RESUME === 'mismatch' ? 'wrong' : p.sessionId });
    case 'session/set_mode': case 'session/set_model': return result(m.id, {});
    case 'session/cancel':
      if (process.env.AGY_TEST_IGNORE_CANCEL === '1') return;
      if (held.has(p.sessionId)) { result(held.get(p.sessionId), { stopReason: 'cancelled' }); held.delete(p.sessionId); }
      for (const [id, request] of pending) if (request.sid === p.sessionId) { result(request.id, { stopReason: 'cancelled' }); pending.delete(id); }
      return;
    case 'session/prompt': {
      const text = p.prompt?.[0]?.text ?? '', sid = p.sessionId;
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thought' } });
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'activity', name: 'read_file', title: 'Read project', status: 'in_progress' });
      update('foreign-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DO NOT PUBLISH' } });
      if (text.includes('crash child')) process.exit(8);
      if (text.includes('oversized')) { update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(481 * 1024) } }); return; }
      if (text.includes('hold')) { held.set(sid, m.id); return; }
      if (text.includes('permission')) {
        // Deliberately collide with a client request ID; bidirectional IDs are separate.
        const id = text.includes('numeric permission') ? 1 : String(++serverId);
        pending.set(id, { sid, id: m.id });
        const options = text.includes('no once permission') ? [{ optionId: 'always', kind: 'allow_always', name: 'Always' }] : [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }];
        send({ id, method: 'session/request_permission', params: { sessionId: sid, toolCall: { sessionUpdate: 'tool_call', toolCallId: 'call-'+randomUUID(), name: 'run_command', args: { CommandLine: 'echo HELLO_AGY' }, rawInput: { CommandLine: 'echo HELLO_AGY' }, status: 'pending', kind: 'execute', title: 'echo HELLO_AGY' }, options } });
        return;
      }
      if (text.includes('tools')) {
        const config = sessions.get(sid).mcpServers[0];
        if (!config.env.every(e => typeof e.name === 'string' && typeof e.value === 'string')) throw new Error('ACP env must be an array');
        const transport = new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...Object.fromEntries(config.env.map(e => [e.name, e.value])) } });
        const client = new Client({ name: 'agy-mock', version: '1' });
        try {
          await client.connect(transport);
          log({ kind: 'tools', result: await client.listTools() });
          log({ kind: 'history', result: await client.callTool({ name: 'nia_group_chat_history', arguments: { limit: 3 } }) });
          const content = text.includes('second-tools') ? 'Second scoped update' : 'ACP interim';
          log({ kind: 'send', result: await client.callTool({ name: 'nia_group_chat_send_message', arguments: { content } }) });
        } finally { await client.close(); }
        return finish(m.id, sid, 'Internal status only');
      }
      if (text.includes('parallel-A')) return setTimeout(() => finish(m.id, sid, 'Reply A'), 75);
      if (text.includes('parallel-B')) return setTimeout(() => finish(m.id, sid, 'Reply B'), 5);
      return finish(m.id, sid);
    }
    default: return send({ id: m.id, error: { code: -32601, message: 'Unknown method' } });
  }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method) void request(m).catch(error => { console.error(error.message); process.exitCode = 1; });
  else {
    log({ kind: 'response', frame: m }); const req = pending.get(m.id);
    if (req) { pending.delete(m.id); finish(req.id, req.sid, m.result?.outcome?.optionId === 'allow' ? 'Allowed' : 'Denied'); }
  }
});
