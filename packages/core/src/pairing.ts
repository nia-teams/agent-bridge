import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from './browser.js';
export { openBrowser } from './browser.js';
import { inviteRegistrationMessage } from './crypto.js';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeServerUrl, requestJson } from './http.js';
import { registrationMessage, signMessage, challengeMessage } from './crypto.js';
import { configDirectory, defaultConfigDir, loadCredentials, saveCredentials } from './credentials.js';
import type { Credentials, Challenge, Lease } from './types.js';

export interface PairOptions {
  clientName?: string; avatar?: string; hostPrefix?: string; cliCommandName?: string; serverUrl?: string; configDir?: string; hostLabel?: string; timeoutMs?: number;
  signal?: AbortSignal; onPairing?: (info: { pairingCode: string; verificationUrl: string }) => void;
  /** Poll interval override for embedded clients/tests; CLI uses two seconds. */
  pollIntervalMs?: number;
}
export async function pairHost(options: PairOptions = {}): Promise<Credentials> {
  const serverUrl = normalizeServerUrl(options.serverUrl || process.env.NIA_TEAMS_URL || 'https://nia-teams.com');
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Pairing timeout must be positive');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const hostLabel = options.hostLabel || `${options.hostPrefix ?? 'agent-bridge'}@${hostname()}`;
  const registrationNonce = randomBytes(32).toString('base64url');
  const start = await requestJson<{ pairingId: string; pairingCode: string; verificationUrl: string }>(serverUrl, '/api/agent-bridge/pairing/start', { publicKey: publicKeyPem, hostLabel, registrationNonce, clientName: options.clientName, avatar: options.avatar }, signal);
  options.onPairing?.(start);
  while (true) {
    signal.throwIfAborted();
    const status = await requestJson<{ status: string; teamId: string; approvedByUserId: string; pairingId: string }>(serverUrl, `/api/agent-bridge/pairing/status?reference=${encodeURIComponent(start.pairingId)}`, undefined, signal);
    if (status.status === 'approved') {
      const signature = signMessage(registrationMessage(start.pairingId, status.teamId, registrationNonce, status.approvedByUserId), privateKeyPem);
      const completed = await requestJson<{ ok: boolean; teamId: string; agentSlug: string; agentName: string; issuer: string; keyGeneration: number }>(serverUrl, '/api/agent-bridge/pairing/complete', { pairingReference: start.pairingId, signature }, signal);
      if (!completed.ok || completed.teamId !== status.teamId) throw new Error('Pairing response does not match approved Agent');
      const credentials: Credentials = { serverUrl, teamId: completed.teamId, agentSlug: completed.agentSlug, agentName: completed.agentName, issuer: completed.issuer, keyGeneration: completed.keyGeneration, hostLabel, publicKeyPem, privateKeyPem, pairedAt: new Date().toISOString() };
      await saveCredentials(credentials, options.configDir);
      return credentials;
    }
    if (status.status === 'expired') throw new Error(`Pairing expired; run ${options.cliCommandName ?? 'nia-bridge'} pair again`);
    if (status.status === 'paired') throw new Error(`Pairing already consumed; run ${options.cliCommandName ?? 'nia-bridge'} pair again`);
    if (status.status !== 'pending') throw new Error('Unexpected pairing status');
    await delay(options.pollIntervalMs ?? 2000, undefined, { signal });
  }
}
export async function acquireLease(credentials: Credentials, signal?: AbortSignal, branding: Pick<PairOptions, 'clientName' | 'avatar'> = {}): Promise<Lease> {
  const challenge = await requestJson<Challenge>(credentials.serverUrl, '/api/agent-bridge/challenge', { teamId: credentials.teamId }, signal);
  if (challenge.teamId !== credentials.teamId || challenge.keyGeneration !== credentials.keyGeneration) throw new Error('Agent key generation changed; pair this host again');
  const lease = await requestJson<Lease>(credentials.serverUrl, '/api/agent-bridge/lease', {
    teamId: credentials.teamId, challengeId: challenge.challengeId, signature: signMessage(challengeMessage(challenge), credentials.privateKeyPem), clientName: branding.clientName, avatar: branding.avatar,
  }, signal);
  if (lease.issuer !== credentials.issuer) throw new Error('OIDC issuer changed; pair this host again');
  const url = new URL(lease.gatewayUrl);
  const base = new URL(credentials.serverUrl);
  if (url.protocol !== (base.protocol === 'https:' ? 'wss:' : 'ws:') || url.host !== base.host || url.pathname !== '/ws/agent-bridge' || url.username || url.password || url.search || url.hash) throw new Error('Invalid Agent Bridge gateway URL');
  return lease;
}

export async function runPairingCli(options: PairOptions = {}): Promise<Credentials> {
  const result = await pairHost({ ...options, onPairing: options.onPairing ?? (info => console.log(`Pairing code: ${info.pairingCode}\nOpen this URL to create or bind your external Agent:\n${info.verificationUrl}`)) });
  console.log(`Paired: ${result.agentName} (@${result.agentSlug})`);
  return result;
}

export interface InviteConnectOptions {
  inviteCode: string; userName?: string; agentName?: string; serverUrl?: string; configDir?: string;
  hostPrefix?: string; hostLabel?: string; clientName?: string; avatar?: string; openBrowser?: boolean;
}
export interface InviteConnectResult {
  mode: 'paired' | 'reused'; credentials: Credentials; userId: string; groupChatId: string; handoffUrl: string; browserOpened: boolean;
}
interface InviteResponse {
  ok: boolean; userId: string; teamId: string; agentSlug: string; agentName: string;
  issuer: string; keyGeneration: number; groupChatId: string; handoffUrl: string;
}
export async function connectWithInvite(options: InviteConnectOptions): Promise<InviteConnectResult> {
  const configDir = options.configDir ?? defaultConfigDir();
  let existing: Credentials | undefined;
  try { existing = await loadCredentials(configDir); }
  catch (error) {
    // Only an absent file permits registration; corrupt/insecure credentials are errors.
    const file = await lstat(join(configDir, 'credentials.json')).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });
    if (file) throw error;
    await configDirectory(configDir, true);
  }
  const serverUrl = normalizeServerUrl(options.serverUrl || existing?.serverUrl || process.env.NIA_TEAMS_URL || 'https://nia-teams.com');
  const inviteCode = options.inviteCode.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,64}$/.test(inviteCode)) throw new Error('Invalid --invite-code: expected 4–64 letters, digits, underscores or hyphens');
  let credentials: Credentials, response: InviteResponse, mode: InviteConnectResult['mode'];
  if (existing && normalizeServerUrl(existing.serverUrl) === serverUrl) {
    let challenge: Challenge;
    try { challenge = await requestJson<Challenge>(serverUrl, '/api/agent-bridge/challenge', { teamId: existing.teamId }); }
    catch (error) { throw new Error(`Existing Agent challenge failed: ${error instanceof Error ? error.message : String(error)} (possibly deleted, archived or unbound); explicitly clear credentials or re-pair this host before connecting again`, { cause: error }); }
    if (challenge.teamId !== existing.teamId || challenge.keyGeneration !== existing.keyGeneration) throw new Error('Existing Agent key generation changed; explicitly re-pair this host');
    response = await requestJson<InviteResponse>(serverUrl, '/api/agent-bridge/invite-group-chat', {
      teamId: existing.teamId, challengeId: challenge.challengeId, signature: signMessage(challengeMessage(challenge), existing.privateKeyPem), inviteCode,
    });
    if (response.teamId !== existing.teamId) throw new Error('Invite response does not match existing Agent');
    credentials = existing; mode = 'reused';
  } else {
    const userName = (options.userName ?? '').replace(/\s+/g, ' ').trim();
    const agentName = (options.agentName ?? '').replace(/\s+/g, ' ').trim();
    if (!userName || !agentName) throw new Error('First connect requires --user-name and --agent-name');
    if (userName.length > 60 || agentName.length > 60) throw new Error('--user-name and --agent-name must each be 1–60 characters');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const registrationNonce = randomBytes(32).toString('base64url');
    const hostLabel = options.hostLabel || `${options.hostPrefix ?? 'agent-bridge'}@${hostname()}`;
    response = await requestJson<InviteResponse>(serverUrl, '/api/agent-bridge/pairing/invite', {
      inviteCode, userName, agentName, publicKey: publicKeyPem, registrationNonce,
      signature: signMessage(inviteRegistrationMessage(inviteCode, userName, agentName, registrationNonce), privateKeyPem),
      hostLabel, clientName: options.clientName, avatar: options.avatar,
    });
    if (!response.ok) throw new Error('Invite registration failed');
    credentials = { serverUrl, teamId: response.teamId, agentSlug: response.agentSlug, agentName: response.agentName,
      issuer: response.issuer, keyGeneration: response.keyGeneration, hostLabel, publicKeyPem, privateKeyPem, pairedAt: new Date().toISOString() };
    mode = 'paired';
  }
  if (!response.ok || !response.userId || !response.groupChatId || !response.handoffUrl) throw new Error('Invalid invite response');
  let handoff: URL;
  try { handoff = new URL(response.handoffUrl); }
  catch { throw new Error('Invalid invite handoff URL'); }
  if (!['http:', 'https:'].includes(handoff.protocol) || handoff.username || handoff.password ||
    (new URL(serverUrl).protocol === 'https:' && handoff.protocol !== 'https:')) throw new Error('Invalid invite handoff URL');
  if (mode === 'paired') await saveCredentials(credentials, configDir);
  const browserOpened = options.openBrowser !== false && !process.env.NIA_NO_BROWSER ? await openBrowser(response.handoffUrl) : false;
  return { mode, credentials, userId: response.userId, groupChatId: response.groupChatId, handoffUrl: response.handoffUrl, browserOpened };
}
export async function runInviteConnectCli(options: InviteConnectOptions): Promise<InviteConnectResult> {
  const result = await connectWithInvite(options);
  console.log(`Agent: ${result.credentials.agentName} (@${result.credentials.agentSlug})\nGroupChat: ${result.groupChatId}\nHandoff URL: ${result.handoffUrl}`);
  return result;
}
