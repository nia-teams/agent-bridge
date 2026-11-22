import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const groupToken = 'aBcDeFGhIjKLmnoPQRstUvwxYZ_01234.aBC-def';
export const flowId = 'f'.repeat(48);
export const pollSecret = 'secret-only-for-the-host';
const base = '/api/agent-bridge';
export const startPath = `${base}/connect/start`;
export const statusPath = `${base}/connect/status?flowId=${flowId}`;
export const challengePath = `${base}/challenge`;
export const joinPath = `${base}/connect/join-group`;

export async function connectFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nia-connect-'));
  const f = { dir, requests: [], generation: 1, challengeStatus: 200, joinStatus: 200, startStatus: 200, pollStatus: 200, pending: 0 };
  const teamId = '0123456789abcdef01234567';
  let challengeNumber = 0;
  const challenge = () => ({ challengeId: `challenge-${challengeNumber}`, teamId, keyGeneration: f.generation, nonce: 'nonce' });
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      f.requests.push({ path: req.url, body });
      const reply = (data, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
      if (req.url !== statusPath) assert.equal(req.headers['x-poll-secret'], undefined);
      const group = () => ({ userId: 'alice', teamId, agentSlug: 'external-helper', agentName: f.agentName,
        groupChatId: 'group-fixture', groupChatTitle: 'Local Chat', handoffUrl: f.handoffUrl ?? f.defaultHandoffUrl });
      if (req.url === startPath) {
        assert.equal(req.method, 'POST');
        assert.equal(body.agentName, body.agentName.replace(/\s+/g, ' ').trim());
        if (body.groupInviteToken !== undefined) assert.equal(body.groupInviteToken, groupToken);
        assert.match(body.registrationNonce, /^[A-Za-z0-9_-]{43}$/);
        assert.match(body.signature, /^[A-Za-z0-9_-]{86}$/);
        const bytes = ['nia-agent-bridge-connect-v1', body.agentName, body.registrationNonce, body.groupInviteToken ?? ''].join('\n');
        assert.ok(verify(null, Buffer.from(bytes), body.publicKey, Buffer.from(body.signature, 'base64url')));
        f.publicKey = body.publicKey;
        f.agentName = body.agentName;
        return reply({ flowId, pollSecret, qrUrl: f.qrUrl, expiresInSeconds: 600 }, f.startStatus);
      }
      if (req.url === statusPath) {
        assert.equal(req.method, 'GET'); assert.equal(body, undefined); assert.equal(req.headers['x-poll-secret'], pollSecret);
        if (f.pollStatus !== 200) return reply({}, f.pollStatus);
        if (f.expired) return reply({ status: 'expired' });
        if (f.pending > 0) { f.pending--; return reply({ status: 'pending' }); }
        return reply({ status: 'complete', ...group(), issuer: f.url, keyGeneration: 1 });
      }
      if (req.url === challengePath) {
        assert.equal(req.method, 'POST'); assert.deepEqual(body, { teamId });
        if (f.holdChallenge) return;
        challengeNumber++;
        return reply(challenge(), f.challengeStatus);
      }
      if (req.url === joinPath) {
        assert.equal(req.method, 'POST');
        assert.deepEqual(Object.keys(body).sort(), ['challengeId', ...(body.groupInviteToken === undefined ? [] : ['groupInviteToken']), 'signature', 'teamId']);
        if (body.groupInviteToken !== undefined) assert.equal(body.groupInviteToken, groupToken);
        assert.equal(body.challengeId, challenge().challengeId); assert.equal(body.teamId, teamId);
        assert.ok(verify(null, Buffer.from(`nia-agent-bridge-auth-v1\n${body.challengeId}\n${teamId}\n1\nnonce`), f.publicKey, Buffer.from(body.signature, 'base64')));
        return reply({ ok: true, ...group() }, f.joinStatus);
      }
      reply({}, 404);
    } catch (error) { f.error = error; res.statusCode = 500; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.url = `http://127.0.0.1:${server.address().port}`;
  f.qrUrl = 'https://wechat.example/api/auth/wechat?bindToken=fixture';
  f.defaultHandoffUrl = `${f.url}${base}/handoff?code=fixture`;
  f.options = { agentName: ' Local\tHelper ', serverUrl: f.url, configDir: dir, openBrowser: false, pollIntervalMs: 1 };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); if (f.error) throw f.error; });
  return f;
}
