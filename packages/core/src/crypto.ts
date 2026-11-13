import { createHash, sign } from 'node:crypto';
import type { Challenge } from './types.js';

export function stableExternalAgentThreadId(groupChatId: string, teamId: string): string {
  return `nia-gc-${createHash('sha256').update(`${groupChatId}:${teamId}`).digest('base64url').slice(0, 24)}`;
}
export function registrationMessage(pairingId: string, teamId: string, nonce: string, userId: string): string {
  return ['nia-agent-bridge-register-v1', pairingId, teamId, nonce, userId].join('\n');
}
export function challengeMessage(challenge: Challenge): string {
  return ['nia-agent-bridge-auth-v1', challenge.challengeId, challenge.teamId, String(challenge.keyGeneration), challenge.nonce].join('\n');
}
export function signMessage(message: string, privateKeyPem: string): string {
  return sign(null, Buffer.from(message, 'utf8'), privateKeyPem).toString('base64');
}

export const signEd25519 = signMessage;
