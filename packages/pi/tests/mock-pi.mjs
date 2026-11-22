#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i], process.argv[i + 1]);
assert.equal(flags.get('--mode'), 'rpc');
const log = (type, data = {}) => appendFile('mock-pi.jsonl', `${JSON.stringify({ type, ...data })}\n`);
const resume = flags.get('--session');
const sessionFile = resume ?? join(flags.get('--session-dir'), `${randomUUID()}.jsonl`);
const promptPath = flags.get('--append-system-prompt');
await log('start', { flags: Object.fromEntries(flags), sessionFile, systemPrompt: promptPath && await readFile(promptPath, 'utf8'), endpoint: process.env.NIA_BRIDGE_MCP_URL });
if (resume && await readFile(resume, 'utf8') === 'unloadable') {
  console.error(`Session file is not a valid pi session: ${resume}`);
  process.exit(1);
}
const tools = new Map();
const { default: extension } = await import(pathToFileURL(flags.get('-e')));
await extension({ registerTool: definition => tools.set(definition.name, definition) });
const emit = record => process.stdout.write(`${JSON.stringify(record)}\r\n`);
const reply = ({ id, type }, data, error) => emit({ type: 'response', id, command: type, success: !error, data, error });
const settle = (aborted = false) => emit({ type: 'agent_settled', aborted });
let behavior, streaming = false, compacting = false, queued = 0;
const agentStart = () => { streaming = true; emit({ type: 'agent_start' }); };
const agentEnd = () => { emit({ type: 'agent_end', messages: [] }); };
function assistant(stopReason, errorMessage) {
  emit({ type: 'message_end', message: { role: 'assistant', stopReason, errorMessage } });
}
async function sendTool(content) {
  await tools.get('send_message').execute(randomUUID(), { content });
}
async function legacyRun(message) {
  if (message === 'legacy delayed') await delay(650);
  agentStart();
  if (message === 'legacy retry') {
    assistant('error', 'temporary overload');
    agentEnd();
    streaming = false;
    emit({ type: 'auto_retry_start', delayMs: 500 });
    await delay(500);
    agentStart();
    await sendTool('Pi retry completed');
    assistant('stop');
    emit({ type: 'auto_retry_end', success: true });
  } else if (message === 'legacy compaction') {
    assistant('error', 'context overflow');
    agentEnd();
    streaming = false;
    compacting = true;
    emit({ type: 'compaction_start', reason: 'overflow' });
    await delay(500);
    compacting = false;
    emit({ type: 'compaction_end', reason: 'overflow', willRetry: true });
    await delay(500);
    agentStart();
    await sendTool('Pi compaction recovery completed');
    assistant('stop');
  } else if (message === 'legacy delayed') {
    await sendTool('Pi delayed run completed');
    assistant('stop');
  } else if (message === 'legacy error') assistant('error', 'legacy provider failed');
  else assistant('stop');
  agentEnd();
  // get_state must prevent shutdown until streaming and queued work have drained.
  queued = 1;
  await delay(450);
  streaming = false;
  await delay(450);
  queued = 0;
  await log('legacy drained', { message });
}
const dialogs = new Set();

async function receive(request) {
  const { type, message } = request;
  if (type === 'get_state') {
    await log('state', { streaming, compacting, queued });
    return reply(request, { sessionFile, isStreaming: streaming, isCompacting: compacting, pendingMessageCount: queued });
  }
  if (type === 'abort') {
    await log('abort', { id: request.id });
    if (behavior === 'hang') return;
    settle(true);
    return reply(request);
  }
  if (type === 'extension_ui_response') {
    assert.equal(request.cancelled, true);
    assert.ok(dialogs.delete(request.id));
    await log('dialog', { id: request.id });
    if (dialogs.size === 0) settle();
    return;
  }
  assert.equal(type, 'prompt');
  behavior = message;
  await log('prompt', { message, sessionFile });
  if (!resume) await writeFile(sessionFile, 'mock session');
  if (message === 'handled') return reply(request, { disposition: 'handled' });
  if (message.startsWith('legacy ')) {
    reply(request);
    void legacyRun(message).catch(error => { console.error(error); process.exit(1); });
    return;
  }
  if (message === 'invalid disposition') return reply(request, { disposition: 'unknown' });
  if (message === 'fail') return reply(request, undefined, 'mock prompt rejected');
  if (message === 'exit') process.exit(3);
  if (message === 'fast') { settle(); return reply(request, { disposition: 'started' }); }
  reply(request, { disposition: 'started' });
  if (message === 'modern delayed') {
    agentStart();
    agentEnd();
    streaming = false;
    await delay(500);
    await sendTool('Pi settled only after follow-up');
    return settle();
  }
  if (message === 'model error') {
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'mock provider failed' } });
    return settle();
  }
  if (message === 'hold' || message === 'hang') {
    emit({ type: 'tool_execution_start', toolName: 'mock_wait' });
    return;
  }
  if (message === 'dialogs') {
    for (const method of ['select', 'confirm', 'input', 'editor', 'notify']) {
      const id = randomUUID();
      if (method !== 'notify') dialogs.add(id);
      emit({ type: 'extension_ui_request', id, method });
    }
    return;
  }
  emit({ type: 'agent_end', messages: [] });
  if (message === 'use tools') {
    // This arrives after agent_end, as follow-up work can in Pi.
    await delay(50);
    for (const [name, args] of [['chat_history', { limit: 2 }], ['send_message', { content: 'Pi interim' }]]) {
      emit({ type: 'tool_execution_start', toolName: name });
      const tool = tools.get(name);
      assert.ok(tool, `missing tool ${name}`);
      const result = await tool.execute(randomUUID(), args, new AbortController().signal);
      assert.equal(result.content[0].type, 'text');
    }
  }
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Private\u2028Pi\u2029final' }] } });
  settle();
}

let pending = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  const lines = (pending + chunk).split('\n');
  pending = lines.pop();
  for (const line of lines) if (line) await receive(JSON.parse(line));
}
