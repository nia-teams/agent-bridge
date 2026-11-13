import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { defaultConfigDir, signEd25519, formatThreadMessage } from '../dist/index.js';
import { message } from './helpers.mjs';

test('signEd25519 signs exact UTF-8 bytes with the shared canonical signer', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = signEd25519('message\n消息', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  assert.ok(verify(null, Buffer.from('message\n消息'), publicKey, Buffer.from(signature, 'base64')));
  assert.equal(verify(null, Buffer.from('message\n消息\n'), publicKey, Buffer.from(signature, 'base64')), false);
});

test('defaultConfigDir parameterizes adapter directory and environment override without trusting either', () => {
  assert.ok(defaultConfigDir('adapter-a').endsWith('/.config/adapter-a'));
  process.env.NIA_CORE_TEST_CONFIG = '/example/config';
  try { assert.equal(defaultConfigDir('adapter-a', 'NIA_CORE_TEST_CONFIG'), '/example/config'); }
  finally { delete process.env.NIA_CORE_TEST_CONFIG; }
});

test('formatThreadMessage includes members, organization, reply IDs, attachments and transcripts', () => {
  const f = message('Question'); f.reason = 'joined'; f.groupChat.members[0].orgName = 'Acme';
  f.messages[0].replyToMessageId = 'prior-message';
  f.messages[0].attachments = [{ name: 'recording.ogg', mimeType: 'audio/ogg', size: 10, url: 'https://example.com/recording', transcript: 'Spoken question' }];
  const result = formatThreadMessage(f);
  assert.match(result, /# GroupChat: Project chat/); assert.match(result, /Members: Alex .*\[Acme\]/);
  assert.match(result, /You have joined/); assert.match(result, /replyToMessageId: prior-message/);
  assert.match(result, /Attachment: recording.ogg \(audio\/ogg, 10 bytes\)/);
  assert.match(result, /Transcript: Spoken question/);
});
