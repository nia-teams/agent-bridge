import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createWorkloadOidcProvider, generateTestRsaKeyPair, signTestConfirmationToken } from '@nia-teams/mcp-sdk/testing';
import { stableExternalAgentThreadId, saveCredentials } from '../dist/index.js';

export const teamId = '0123456789abcdef01234567';
export const sessionId = '123456789abcdef012345678';
export const groupChatId = '23456789abcdef0123456789';
export const userId = '3456789abcdef0123456789a';
export const agentThreadId = stableExternalAgentThreadId(groupChatId, teamId);
export async function until(predicate, label = 'condition', timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
export function message(content = 'Hello', deliveryId = randomUUID()) {
  const id = randomUUID();
  return { type: 'thread.message', protocolVersion: 1, deliveryId, groupChatId, sessionId, agentThreadId, reason: 'message',
    groupChat: { title: 'Project chat', url: 'https://nia-teams.com/chat/example', members: [{ kind: 'human', id: userId, name: 'Alex' }] },
    invokedBy: { userId, userName: 'Alex' }, triggerMessageId: id,
    messages: [{ id, kind: 'human', authorId: userId, authorName: 'Alex', content, createdAt: new Date().toISOString() }],
  };
}
// SDK 0.1.0 exports a provider factory, not a createMockOidcProvider convenience function.
export async function createMockOidcProvider(issuer) {
  return createWorkloadOidcProvider({ issuer, audience: 'nia-teams-workload', tokenTtlSeconds: 120, activeKey: await generateTestRsaKeyPair() });
}
export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nia-claude-test-'));
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true });
  const challenges = new Map(); const leases = new Set();
  const fixture = { dir, sockets, rpcs: [], frames: [], requests: [], starts: [], connections: 0, pendingPolls: 1, holdRpc: new Set(), credentials: undefined };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, fixture.url);
      let body;
      if (req.method === 'POST') {
        const parts = []; for await (const part of req) parts.push(part);
        body = JSON.parse(Buffer.concat(parts).toString());
      }
      fixture.requests.push({ path: url.pathname, body });
      const reply = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (url.pathname === '/oauth2/jwks') return reply(await fixture.provider.getJwks());
      if (url.pathname === '/api/agent-bridge/pairing/start') {
        assert.match(body.publicKey, /^-----BEGIN PUBLIC KEY-----/);
        assert.ok(body.registrationNonce.length >= 16);
        fixture.registration = body; fixture.starts.push(body);
        return reply({ pairingId: 'pair-id', pairingCode: 'A1B2C3D4', expiresInSeconds: 600, verificationUrl: `${fixture.url}/api/agent-bridge/pair?code=A1B2C3D4` });
      }
      if (url.pathname === '/api/agent-bridge/pairing/status') {
        assert.equal(url.searchParams.get('reference'), 'pair-id');
        if (fixture.pairStatus) return reply({ status: fixture.pairStatus });
        if (fixture.pendingPolls-- > 0) return reply({ status: 'pending', pairingId: 'pair-id', pairingCode: 'A1B2C3D4' });
        return reply({ status: 'approved', pairingId: 'pair-id', teamId, approvedByUserId: userId, agentSlug: 'helper', agentName: 'Helper', issuer: fixture.url });
      }
      if (url.pathname === '/api/agent-bridge/pairing/complete') {
        assert.equal(body.pairingReference, 'pair-id');
        const bytes = `nia-agent-bridge-register-v1\npair-id\n${teamId}\n${fixture.registration.registrationNonce}\n${userId}`;
        assert.ok(verify(null, Buffer.from(bytes), fixture.registration.publicKey, Buffer.from(body.signature, 'base64')));
        return reply({ ok: true, teamId, agentSlug: 'helper', agentName: 'Helper', keyGeneration: 1, issuer: fixture.url });
      }
      if (url.pathname === '/api/agent-bridge/challenge') {
        assert.deepEqual(body, { teamId });
        const challenge = { challengeId: randomUUID(), teamId, keyGeneration: fixture.keyGeneration ?? 1, nonce: randomUUID(), expiresInSeconds: 120 };
        challenges.set(challenge.challengeId, challenge); return reply(challenge);
      }
      if (url.pathname === '/api/agent-bridge/lease') {
        assert.equal(body.teamId, teamId);
        const challenge = challenges.get(body.challengeId); assert.ok(challenge);
        const bytes = `nia-agent-bridge-auth-v1\n${challenge.challengeId}\n${teamId}\n${challenge.keyGeneration}\n${challenge.nonce}`;
        assert.ok(verify(null, Buffer.from(bytes), fixture.credentials.publicKeyPem, Buffer.from(body.signature, 'base64')));
        challenges.delete(body.challengeId);
        const lease = randomUUID(); leases.add(lease);
        return reply({ lease, expiresInSeconds: 60, gatewayUrl: `${fixture.url.replace('http:', 'ws:')}/ws/agent-bridge`, issuer: fixture.url });
      }
      res.statusCode = 404; res.end();
    } catch (error) { fixture.serverError = error; res.statusCode = 500; res.end('test server failed'); }
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws/agent-bridge') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  fixture.url = `http://localhost:${server.address().port}`;
  fixture.provider = await createMockOidcProvider(fixture.url);
  const keys = generateKeyPairSync('ed25519');
  fixture.credentials = { serverUrl: fixture.url, teamId, agentSlug: 'helper', agentName: 'Helper', issuer: fixture.url, keyGeneration: 1, hostLabel: 'test host', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(), privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pairedAt: new Date().toISOString() };
  await saveCredentials(fixture.credentials, dir);
  fixture.send = frame => { assert.ok(fixture.socket); fixture.socket.send(JSON.stringify(frame)); };
  fixture.confirm = async (card, { tamper = false, decision = 'approved', claims, tokenTransform } = {}) => {
    const token = await signTestConfirmationToken(fixture.provider, { server: 'agent-bridge', tool: card.params.verifyToolName,
      arguments: tamper ? { ...card.params.verifyArguments, altered: true } : card.params.verifyArguments, cardId: card.params.cardId, claims,
    });
    fixture.send({ type: 'card.action', protocolVersion: 1, deliveryId: randomUUID(), sessionId: card.params.sessionId, groupChatId, agentThreadId,
      cardId: card.params.cardId, decision, clickedBy: { userId, name: 'Alex', teamRole: 'member' }, _meta: { 'nia/confirmationToken': tokenTransform ? tokenTransform(token) : token } });
  };
  wss.on('connection', ws => {
    sockets.add(ws); fixture.connections++;
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', async bytes => {
      const frame = JSON.parse(bytes.toString()); fixture.frames.push(frame);
      if (frame.type === 'hello') {
        assert.equal(frame.protocolVersion, 1); assert.equal(frame.teamId, teamId); assert.ok(leases.delete(frame.lease));
        fixture.socket = ws;
        const ready = () => {
          ws.send(JSON.stringify({ type: 'ready', protocolVersion: 1, connectionGeneration: randomUUID(), agent: { teamId, slug: 'helper', name: 'Helper' }, issuer: fixture.url }));
          fixture.onReady?.(ws);
        };
        if (fixture.holdReady) fixture.waitingReady = ready; else ready();
      } else if (frame.type === 'rpc.request') {
        fixture.rpcs.push(frame);
        if (fixture.handleRpc?.(frame, ws)) return;
        if (fixture.holdRpc.has(frame.method)) return;
        const result = frame.method === 'group_chat.history' ? { text: 'Earlier chat' } : frame.method === 'card.upsert' ? { cardId: frame.params.cardId, status: 'pending' } : { ok: true, published: true };
        ws.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 1, requestId: frame.requestId, ok: true, result }));
        fixture.onRpc?.(frame);
      } else if (frame.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat', protocolVersion: 1, at: Date.now() }));
    });
  });
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    if (fixture.serverError) throw fixture.serverError;
  });
  return fixture;
}
