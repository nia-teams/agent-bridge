#!/usr/bin/env node
import { createInterface } from 'node:readline';
const log = []; let n = 0, turn = 0, initialized = false, failResume = false, rejectSteer = false, provider = 'openai';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method !== 'test/log') log.push(m);
  if (!m.method || m.id === undefined && m.method !== 'initialized') return;
  const reply = result => send({ id: m.id, result });
  if (m.method === 'initialize') { if (!m.params.capabilities.experimentalApi) throw new Error('experimentalApi required'); reply({ userAgent: 'mock' }); }
  else if (m.method === 'initialized') { initialized = true; }
  else if (m.method === 'test/log') reply({ log });
  else if (m.method === 'test/config') { provider = m.params.provider ?? provider; failResume = m.params.failResume ?? failResume; rejectSteer = m.params.rejectSteer ?? rejectSteer; reply({}); }
  else if (m.method === 'test/emit') { send(m.params.message); reply({}); }
  else if (!initialized) send({ id: m.id, error: { code: -1, message: 'Missing initialized' } });
  else if (m.method === 'config/read') reply({ config: { model_provider: provider } });
  else if (m.method === 'thread/start') {
    for (const t of m.params.dynamicTools ?? []) {
      if (t.type === 'function') {
        if (!t.inputSchema) throw new Error('Incorrect dynamic tool shape');
        if (t.deferLoading) { send({ id: m.id, error: { code: -32602, message: `deferred dynamic tool must include a namespace: ${t.name}` } }); return; }
      } else if (t.type === 'namespace') {
        if (!t.name || !t.description || !Array.isArray(t.tools) || !t.tools.length || !t.tools.every(fn => fn.type === 'function' && fn.inputSchema)) {
          throw new Error('Incorrect dynamic tool namespace shape');
        }
      } else {
        throw new Error('Incorrect dynamic tool shape');
      }
    }
    reply({ thread: { id: `codex-${++n}` } });
  } else if (m.method === 'thread/resume') {
    if (failResume) { failResume = false; send({ id: m.id, error: { code: -1, message: 'Rollout missing' } }); }
    else reply({ thread: { id: m.params.threadId } });
  } else if (m.method === 'turn/start') {
    if (!m.params.input.every(i => i.type === 'text' && Array.isArray(i.text_elements))) throw new Error('Incorrect text input');
    const id = `turn-${++turn}`, threadId = m.params.threadId;
    reply({ turn: { id, status: 'inProgress', items: [] } });
    send({ method: 'turn/started', params: { threadId, turn: { id } } });
    if (!m.params.input[0].text.includes('hold')) setTimeout(() => {
      send({ method: 'item/completed', params: { threadId, turnId: id, completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'answer', text: 'Hello from Codex', phase: 'final_answer' } } });
      send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items: [] } } });
    }, 30);
  } else if (m.method === 'turn/steer' && rejectSteer) send({ id: m.id, error: { code: -1, message: 'Cannot steer now' } });
  else reply({});
});
