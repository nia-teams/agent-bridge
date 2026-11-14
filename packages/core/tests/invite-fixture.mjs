import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function inviteFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nia-invite-'));
  const f = { dir, requests: [], generation: 1, status: 200 };
  const teamId = '0123456789abcdef01234567';
  const challenge = () => ({ challengeId: 'challenge', teamId, keyGeneration: f.generation, nonce: 'nonce' });
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      f.requests.push({ path: req.url, body });
      const reply = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
      if (req.url === '/api/agent-bridge/challenge') {
        assert.deepEqual(body, { teamId });
        if (f.holdChallenge) { req.on('close', () => res.end()); return; }
        res.statusCode = f.status; return reply(challenge());
      }
      if (req.url === '/api/agent-bridge/pairing/invite') {
        assert.equal(body.inviteCode, 'AB_CD-12');
        assert.equal(body.userName, 'Alice Example'); assert.equal(body.agentName, 'Local Helper');
        assert.match(body.registrationNonce, /^[A-Za-z0-9_-]{43}$/);
        const bytes = ['nia-agent-bridge-invite-v1', 'AB_CD-12', 'Alice Example', 'Local Helper', body.registrationNonce].join('\n');
        assert.ok(verify(null, Buffer.from(bytes), body.publicKey, Buffer.from(body.signature, 'base64')));
        f.publicKey = body.publicKey;
      } else if (req.url === '/api/agent-bridge/invite-group-chat') {
        assert.deepEqual(Object.keys(body).sort(), ['challengeId', 'inviteCode', 'signature', 'teamId']);
        assert.equal(body.inviteCode, 'AB_CD-12');
        assert.ok(verify(null, Buffer.from(`nia-agent-bridge-auth-v1\nchallenge\n${teamId}\n1\nnonce`), f.publicKey, Buffer.from(body.signature, 'base64')));
      } else { res.statusCode = 404; return res.end(); }
      reply({ ok: true, userId: 'alice', teamId, agentSlug: 'external-helper', agentName: 'Local Helper', issuer: f.url,
        keyGeneration: 1, groupChatId: 'group-fixture', handoffUrl: f.handoffUrl ?? `${f.url}/handoff` });
    } catch (error) { f.error = error; res.statusCode = 500; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.url = `http://127.0.0.1:${server.address().port}`;
  f.options = { inviteCode: ' ab_cd-12 ', userName: ' Alice \n Example ', agentName: ' Local\tHelper ', serverUrl: f.url, configDir: dir, openBrowser: false };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); if (f.error) throw f.error; });
  return f;
}
