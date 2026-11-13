import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { BridgeClient, ChannelServer, stableExternalAgentThreadId } from '../dist/index.js';
import { fixture, message, until, groupChatId, sessionId, agentThreadId, teamId, userId } from './helpers.mjs';

const notification = method => z.object({ method: z.literal(method), params: z.record(z.string(), z.unknown()) });
async function setup(t, inbound = true) {
  const f = await fixture(t);
  const bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 10, rpcTimeoutMs: 100 });
  const logs = []; const server = new ChannelServer(bridge, text => logs.push(text));
  const client = new Client({ name: 'test-host', version: '1' });
  const events = []; const verdicts = [];
  client.setNotificationHandler(notification('notifications/claude/channel'), n => { events.push(n.params); });
  client.setNotificationHandler(notification('notifications/claude/channel/permission'), n => { verdicts.push(n.params); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await server.close(); await client.close(); });
  await Promise.all([server.connect(a), client.connect(b)]);
  if (inbound) { f.send(message()); await until(() => events.length === 1); }
  return { f, server, client, events, verdicts, logs };
}
async function permission(ctx, request_id = 'abcde') {
  await ctx.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id, tool_name: 'Bash', description: 'Run tests', input_preview: '{"command":"npm test"}' } });
  await until(() => ctx.f.rpcs.some(r => r.method === 'card.upsert' && r.params.toolCallId === `perm:${request_id}`));
  return ctx.f.rpcs.find(r => r.method === 'card.upsert' && r.params.toolCallId === `perm:${request_id}`);
}
const activity = f => f.rpcs.filter(r => r.method === 'thread.activity');

test('MCP capabilities, instructions, snake_case channel metadata and rich message formatting', async t => {
  const { f, client, events } = await setup(t, false);
  assert.deepEqual(client.getServerCapabilities().experimental, { 'claude/channel': {}, 'claude/channel/permission': {} });
  assert.match(client.getInstructions(), /MUST call nia_group_chat_send_message/);
  assert.equal((await client.listTools()).tools.length, 2);
  const frame = message('Inspect the attachment'); frame.reason = 'joined'; frame.groupChat.members[0].orgName = 'Acme';
  frame.messages[0].replyToMessageId = 'prior'; frame.messages[0].attachments = [{ name: 'log.txt', url: 'https://example.com/log.txt', mimeType: 'text/plain', size: 12, transcript: 'transcript' }];
  f.send(frame); await until(() => events.length === 1);
  assert.deepEqual(events[0].meta, { source: 'nia_teams', group_chat_id: groupChatId, session_id: sessionId, agent_thread_id: agentThreadId, trigger_message_id: frame.triggerMessageId, reason: 'joined', sender_id: userId, sender_name: 'Alex' });
  assert.ok(Object.entries(events[0].meta).every(([k, v]) => /^[a-z0-9_]+$/.test(k) && typeof v === 'string'));
  for (const text of ['Members: Alex', '[Acme]', 'joined', 'replyToMessageId: prior', 'log.txt', 'transcript']) assert.ok(events[0].content.includes(text));
  assert.equal(activity(f).at(-1).params.state, 'executing');
});

test('reply queue replays after transient disconnect, keep_working and final idle; history validates pagination', async t => {
  const { f, client } = await setup(t);
  const args = { group_chat_id: groupChatId, content: 'Progress', keep_working: true };
  assert.ok(!(await client.callTool({ name: 'nia_group_chat_send_message', arguments: args })).isError);
  assert.equal(activity(f).at(-1).params.state, 'executing');
  let lost = false;
  f.handleRpc = (rpc, ws) => { if (rpc.method === 'group_chat.send_message' && !lost) { lost = true; ws.terminate(); return true; } return false; };
  const response = await client.callTool({ name: 'nia_group_chat_send_message', arguments: { group_chat_id: groupChatId, content: 'Final' } });
  assert.ok(!response.isError); assert.equal(activity(f).at(-1).params.state, 'idle');
  const attempts = f.rpcs.filter(r => r.method === 'group_chat.send_message' && r.params.content === 'Final');
  assert.equal(attempts.length, 2); assert.equal(attempts[0].params.toolCallId, attempts[1].params.toolCallId);
  const history = await client.callTool({ name: 'nia_group_chat_history', arguments: { group_chat_id: groupChatId } });
  assert.equal(history.content[0].text, 'Earlier chat');
  assert.deepEqual(f.rpcs.find(r => r.method === 'group_chat.history').params, { sessionId, limit: 50, offset: 0 });
  for (const args of [{ group_chat_id: groupChatId, limit: 101 }, { group_chat_id: groupChatId, offset: -1 }, { group_chat_id: 'bad' }]) {
    assert.equal((await client.callTool({ name: 'nia_group_chat_history', arguments: args })).isError, true);
  }
  assert.equal((await client.callTool({ name: 'nia_group_chat_send_message', arguments: { group_chat_id: groupChatId, content: ' ' } })).isError, true);
});

test('RS256 approval is bound to exact tool arguments and card, emits allow once', async t => {
  const ctx = await setup(t); const card = await permission(ctx);
  assert.equal(card.params.verifyToolName, 'claude_code.permission');
  assert.deepEqual(card.params.verifyArguments, { agentThreadId, requestId: 'abcde', toolName: 'Bash', description: 'Run tests', inputPreview: '{"command":"npm test"}' });
  assert.ok(card.params.cardId.length <= 200); assert.equal(card.params.actionLabel, '允许执行');
  await until(() => activity(ctx.f).at(-1).params.state === 'waiting');
  await ctx.f.confirm(card); await until(() => ctx.verdicts.length === 1);
  assert.deepEqual(ctx.verdicts[0], { request_id: 'abcde', behavior: 'allow' });
  await until(() => activity(ctx.f).at(-1).params.label === 'Running Bash…');
  await ctx.f.confirm(card); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(ctx.verdicts.length, 1);
});

for (const scenario of ['tampered', 'missing', 'canceled', 'invalid-signature', 'wrong-card']) {
  test(`permission ${scenario} fails closed`, async t => {
    const ctx = await setup(t); const card = await permission(ctx);
    if (scenario === 'missing') {
      ctx.f.send({ type: 'card.action', protocolVersion: 1, deliveryId: randomUUID(), groupChatId, sessionId, agentThreadId, cardId: card.params.cardId, decision: 'approved', clickedBy: { userId, name: 'Alex' } });
    } else if (scenario === 'wrong-card') {
      await ctx.f.confirm({ params: { ...card.params, cardId: card.params.cardId + '-other' } });
      // Unknown card is ignored, not a decision on the original pending request.
      await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(ctx.verdicts.length, 0);
      await ctx.f.confirm(card, { tamper: true });
    } else {
      await ctx.f.confirm(card, { tamper: scenario === 'tampered', decision: scenario === 'canceled' ? 'canceled' : 'approved',
        tokenTransform: scenario === 'invalid-signature' ? token => { const parts = token.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1); return parts.join('.'); } : undefined });
    }
    await until(() => ctx.verdicts.length === 1); assert.deepEqual(ctx.verdicts[0], { request_id: 'abcde', behavior: 'deny' });
  });
}

test('permission without GroupChat context stays local; routing prefers latest executing thread and binds identities', async t => {
  const ctx = await setup(t, false);
  await ctx.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'local', tool_name: 'Bash', description: '', input_preview: '' } });
  await until(() => ctx.logs.length > 0); assert.equal(ctx.f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
  ctx.f.send(message()); await until(() => ctx.events.length === 1);
  const other = message('Other chat'); other.groupChatId = 'aaaaaaaaaaaaaaaaaaaaaaaa'; other.sessionId = 'bbbbbbbbbbbbbbbbbbbbbbbb'; other.agentThreadId = stableExternalAgentThreadId(other.groupChatId, teamId);
  ctx.f.send(other); await until(() => ctx.events.length === 2);
  await ctx.client.callTool({ name: 'nia_group_chat_send_message', arguments: { group_chat_id: other.groupChatId, content: 'Done' } });
  const card = await permission(ctx); assert.equal(card.params.sessionId, sessionId, 'latest executing wins over most recently triggered idle chat');
  ctx.f.send({ type: 'card.action', protocolVersion: 1, deliveryId: randomUUID(), groupChatId: other.groupChatId, sessionId: other.sessionId, agentThreadId: other.agentThreadId, cardId: card.params.cardId, decision: 'canceled', clickedBy: { userId, name: 'Alex' } });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(ctx.verdicts.length, 0);
  await ctx.f.confirm(card); await until(() => ctx.verdicts.length === 1);
  assert.equal(ctx.verdicts[0].behavior, 'allow');
});

for (const reason of ['user_aborted', 'removed_from_group']) {
  test(`thread.cancel ${reason} cancels card and idles; shutdown is idempotent`, async t => {
    const ctx = await setup(t); const card = await permission(ctx);
    ctx.f.send({ type: 'thread.cancel', protocolVersion: 1, deliveryId: randomUUID(), groupChatId, sessionId, agentThreadId, reason });
    await until(() => ctx.f.rpcs.some(r => r.method === 'card.cancel'));
    await until(() => activity(ctx.f).at(-1).params.state === 'idle');
    assert.equal(ctx.verdicts[0].behavior, 'deny');
    if (reason === 'user_aborted') { await until(() => ctx.events.length === 2); assert.equal(ctx.events[1].meta.reason, reason); }
    else assert.equal((await ctx.client.callTool({ name: 'nia_group_chat_history', arguments: { group_chat_id: groupChatId } })).isError, true);
    await ctx.f.confirm(card); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(ctx.verdicts.length, 1);
    assert.equal(ctx.server.close(), ctx.server.close());
  });
}

test('shutdown cancels outstanding cards, denies permission and clears active presence', async t => {
  const ctx = await setup(t); await permission(ctx); await ctx.server.close();
  assert.equal(ctx.verdicts.at(-1).behavior, 'deny');
  assert.ok(ctx.f.rpcs.some(r => r.method === 'card.cancel'));
  assert.equal(activity(ctx.f).at(-1).params.state, 'idle');
  await until(() => ctx.f.sockets.size === 0);
});

test('session rotation denies old cards and stale cancel cannot affect new context', async t => {
  const ctx = await setup(t); const card = await permission(ctx);
  const next = message('Next execution'); next.sessionId = 'cccccccccccccccccccccccc'; ctx.f.send(next);
  await until(() => ctx.events.length === 2);
  assert.equal(ctx.verdicts[0].behavior, 'deny');
  assert.ok(ctx.f.rpcs.some(r => r.method === 'card.cancel' && r.params.sessionId === sessionId));
  const before = activity(ctx.f).length;
  ctx.f.send({ type: 'thread.cancel', protocolVersion: 1, deliveryId: randomUUID(), groupChatId, sessionId, agentThreadId, reason: 'removed_from_group' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(activity(ctx.f).length, before);
  await ctx.client.callTool({ name: 'nia_group_chat_history', arguments: { group_chat_id: groupChatId } });
  assert.equal(ctx.f.rpcs.filter(r => r.method === 'group_chat.history').at(-1).params.sessionId, next.sessionId);
  await ctx.f.confirm(card); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(ctx.verdicts.length, 1);
});

test('cancel wins while approval signature verification is in flight', async t => {
  const ctx = await setup(t); const card = await permission(ctx);
  const original = ctx.server.bridge.verifyCardApproval.bind(ctx.server.bridge);
  let release; let verifying = false;
  ctx.server.bridge.verifyCardApproval = async (...args) => { await original(...args); verifying = true; await new Promise(resolve => { release = resolve; }); };
  await ctx.f.confirm(card); await until(() => verifying);
  ctx.f.send({ type: 'thread.cancel', protocolVersion: 1, deliveryId: randomUUID(), groupChatId, sessionId, agentThreadId, reason: 'user_aborted' });
  await until(() => ctx.verdicts.length === 1); assert.equal(ctx.verdicts[0].behavior, 'deny');
  release(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(ctx.verdicts.length, 1);
});

test('signed token for another card fails exact card binding', async t => {
  const { signTestConfirmationToken } = await import('@nia-teams/mcp-sdk/testing');
  const ctx = await setup(t); const card = await permission(ctx);
  const token = await signTestConfirmationToken(ctx.f.provider, { server: 'agent-bridge', tool: 'claude_code.permission', arguments: card.params.verifyArguments, cardId: card.params.cardId + '-wrong' });
  ctx.f.send({ type: 'card.action', protocolVersion: 1, deliveryId: randomUUID(), groupChatId, sessionId, agentThreadId, cardId: card.params.cardId, decision: 'approved', clickedBy: { userId, name: 'Alex' }, _meta: { 'nia/confirmationToken': token } });
  await until(() => ctx.verdicts.length === 1); assert.equal(ctx.verdicts[0].behavior, 'deny');
});
