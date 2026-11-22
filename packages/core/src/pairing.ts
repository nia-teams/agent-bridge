import QRCode from 'qrcode';
import { openBrowser } from './browser.js';
export { openBrowser } from './browser.js';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeHttpError, normalizeServerUrl, requestJson } from './http.js';
import { registrationMessage, signMessage, challengeMessage, connectRegistrationMessage } from './crypto.js';
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

export interface ConnectOptions {
  groupLink?: string; agentName?: string; serverUrl?: string; configDir?: string;
  hostPrefix?: string; hostLabel?: string; clientName?: string; avatar?: string; openBrowser?: boolean;
  /** Maximum time to wait for QR approval. The server may expire the code sooner. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Poll interval override for embedded clients/tests; CLI uses two seconds. */
  pollIntervalMs?: number;
  onScan?: (info: ConnectScanInfo) => void | Promise<void>;
}
export interface ConnectScanInfo { qrUrl: string; expiresInSeconds: number }
export interface ConnectResult {
  mode: 'paired' | 'reused'; credentials: Credentials; userId: string; groupChatId: string;
  groupChatTitle: string; handoffUrl: string; browserOpened: boolean;
}
interface ConnectedChat {
  userId: string; teamId: string; agentSlug: string; agentName: string;
  groupChatId: string; groupChatTitle: string; handoffUrl: string;
}
type ConnectStatus = { status: 'pending' | 'expired' } |
  (ConnectedChat & { status: 'complete'; issuer: string; keyGeneration: number });

export function parseGroupInviteToken(input: string): string {
  let token = input;
  const invalid = () => new Error('Invalid --group-link: expected a /join/<token> URL or a raw group invite token');
  if (input.includes('/')) {
    let url: URL;
    try { url = new URL(input, input.startsWith('/') && !input.startsWith('//') ? 'https://nia-teams.com' : undefined); }
    catch { throw invalid(); }
    if (/^\/share(?:\/|$)/.test(url.pathname)) throw new Error('Read-only /share/ links cannot be used to join a group; use a /join/ invite link');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid();
    const match = /^\/join\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) throw invalid();
    try { token = decodeURIComponent(match[1]!); }
    catch { throw invalid(); }
  }
  if (token.length < 32 || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid();
  return token;
}

function validateConnectUrl(value: string, serverUrl: string, purpose: 'WeChat QR' | 'handoff'): void {
  const invalid = () => new Error(`Invalid ${purpose} URL`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw invalid(); }
  if (/[\u0000-\u0020\u007f-\u009f]/.test(value) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid();
  const base = new URL(serverUrl);
  if (purpose === 'WeChat QR') {
    if (base.protocol === 'https:' && url.protocol !== 'https:') throw invalid();
  } else if (url.origin !== base.origin || url.pathname !== '/api/agent-bridge/handoff') {
    throw invalid();
  }
}

function validateConnectedChat(chat: ConnectedChat, serverUrl: string): void {
  for (const key of ['userId', 'teamId', 'agentSlug', 'agentName', 'groupChatId'] as const) {
    if (typeof chat[key] !== 'string' || !chat[key]) throw new Error(`Invalid connect response: ${key}`);
  }
  if (typeof chat.groupChatTitle !== 'string') throw new Error('Invalid connect response: groupChatTitle');
  validateConnectUrl(chat.handoffUrl, serverUrl, 'handoff');
}

async function joinGroup(credentials: Credentials, groupInviteToken?: string, signal?: AbortSignal): Promise<ConnectedChat> {
  const { serverUrl, teamId } = credentials;
  let challenge: Challenge;
  try { challenge = await requestJson<Challenge>(serverUrl, '/api/agent-bridge/challenge', { teamId }, signal); }
  catch (error) {
    if (error instanceof BridgeHttpError && [401, 403, 404].includes(error.status)) {
      throw new Error(`Existing Agent challenge failed (HTTP ${error.status}); check that the Agent is active and re-pair this host if needed. No new Agent was registered.`, { cause: error });
    }
    throw error;
  }
  if (challenge.teamId !== teamId || challenge.keyGeneration !== credentials.keyGeneration) throw new Error('Existing Agent identity or key generation changed; re-pair this host');
  let chat: ConnectedChat & { ok: true };
  try {
    chat = await requestJson<typeof chat>(serverUrl, '/api/agent-bridge/connect/join-group', {
      teamId, challengeId: challenge.challengeId, signature: signMessage(challengeMessage(challenge), credentials.privateKeyPem), groupInviteToken,
    }, signal);
  } catch (error) {
    if (error instanceof BridgeHttpError && [400, 401, 403, 404, 409].includes(error.status)) {
      throw new Error(`Existing Agent could not connect (HTTP ${error.status}); check the paired credentials${groupInviteToken ? ' and group invite' : ''}. No new Agent was registered.`, { cause: error });
    }
    throw error;
  }
  if (chat.ok !== true || chat.teamId !== teamId) throw new Error('Connect response does not match existing Agent');
  validateConnectedChat(chat, serverUrl);
  return chat;
}

async function registerWithWeChat(serverUrl: string, configDir: string, options: ConnectOptions, groupInviteToken?: string) {
  const agentName = (options.agentName ?? options.clientName ?? 'External Agent').replace(/\s+/g, ' ').trim();
  if (!agentName || agentName.length > 60) throw new Error('--agent-name must be 1–60 characters');
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Connect timeout must be a positive millisecond count');
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 2_147_483_647) throw new Error('Invalid connect poll interval');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const registrationNonce = randomBytes(32).toString('base64url');
  const hostLabel = options.hostLabel || `${options.hostPrefix ?? 'agent-bridge'}@${hostname()}`;
  const registration = { agentName, registrationNonce, groupInviteToken };
  const signature = sign(null, connectRegistrationMessage(registration), privateKey).toString('base64url');
  let start: ConnectScanInfo & { flowId: string; pollSecret: string };
  try {
    start = await requestJson<typeof start>(serverUrl, '/api/agent-bridge/connect/start', {
      ...registration, publicKey: publicKeyPem, signature, hostLabel, clientName: options.clientName, avatar: options.avatar,
    }, options.signal);
  } catch (error) {
    if (error instanceof BridgeHttpError && error.status === 404 && groupInviteToken) {
      throw new Error('Group invite is invalid, expired, or no longer allows joining; request a new /join/ link', { cause: error });
    }
    throw error;
  }
  const { flowId, pollSecret, qrUrl, expiresInSeconds } = start;
  if (typeof flowId !== 'string' || !flowId || typeof pollSecret !== 'string' || !pollSecret ||
    !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) throw new Error('Invalid connect start response');
  validateConnectUrl(qrUrl, serverUrl, 'WeChat QR');
  const timeout = AbortSignal.timeout(Math.min(timeoutMs, expiresInSeconds * 1000));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const expired = 'WeChat QR code expired before approval; run connect again';
  try {
    await options.onScan?.({ qrUrl, expiresInSeconds });
    signal.throwIfAborted();
    while (true) {
      const chat = await requestJson<ConnectStatus>(serverUrl, `/api/agent-bridge/connect/status?flowId=${encodeURIComponent(flowId)}`, undefined, signal, { 'X-Poll-Secret': pollSecret });
      if (chat.status === 'expired') throw new Error(expired);
      if (chat.status === 'pending') {
        await delay(pollIntervalMs, undefined, { signal });
        continue;
      }
      if (chat.status !== 'complete') throw new Error('Unexpected connect status');
      validateConnectedChat(chat, serverUrl);
      if (!/^[a-f\d]{24}$/i.test(chat.teamId) || typeof chat.issuer !== 'string' || !chat.issuer || chat.keyGeneration !== 1) {
        throw new Error('Invalid paired Agent identity in connect response');
      }
      const credentials: Credentials = { serverUrl, teamId: chat.teamId, agentSlug: chat.agentSlug, agentName: chat.agentName,
        issuer: chat.issuer, keyGeneration: chat.keyGeneration, hostLabel, publicKeyPem, privateKeyPem, pairedAt: new Date().toISOString() };
      await saveCredentials(credentials, configDir);
      return { chat, credentials };
    }
  } catch (error) {
    if (timeout.aborted && !options.signal?.aborted && (error === timeout.reason || (error as Error)?.name === 'AbortError')) throw new Error(expired, { cause: error });
    throw error;
  }
}

export async function connectWithWeChat(options: ConnectOptions = {}): Promise<ConnectResult> {
  const groupInviteToken = options.groupLink === undefined ? undefined : parseGroupInviteToken(options.groupLink);
  const configDir = await configDirectory(options.configDir ?? defaultConfigDir(), true);
  let existing: Credentials | undefined;
  try { existing = await loadCredentials(configDir); }
  catch (error) {
    // Only an absent file permits registration; corrupt/insecure credentials are errors.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const serverUrl = normalizeServerUrl(options.serverUrl || process.env.NIA_TEAMS_URL || existing?.serverUrl || 'https://nia-teams.com');
  const reused = existing && normalizeServerUrl(existing.serverUrl) === serverUrl ? existing : undefined;
  const { chat, credentials } = reused
    ? { chat: await joinGroup(reused, groupInviteToken, options.signal), credentials: reused }
    : await registerWithWeChat(serverUrl, configDir, options, groupInviteToken);
  const browserOpened = options.openBrowser !== false && await openBrowser(chat.handoffUrl);
  return { mode: reused ? 'reused' : 'paired', credentials, userId: chat.userId, groupChatId: chat.groupChatId,
    groupChatTitle: chat.groupChatTitle, handoffUrl: chat.handoffUrl, browserOpened };
}

function terminalQr(url: string): string {
  const { size, data } = QRCode.create(url).modules;
  const dark = (x: number, y: number) => x >= 0 && x < size && y >= 0 && y < size && data[y * size + x];
  // Four-module quiet zone and two modules per character row. Use fixed colors on any terminal theme.
  const rows: string[] = [];
  for (let y = -4; y < size + 4; y += 2) {
    let row = '';
    for (let x = -4; x < size + 4; x++) row += dark(x, y) ? (dark(x, y + 1) ? '█' : '▀') : (dark(x, y + 1) ? '▄' : ' ');
    rows.push(`\x1b[30;47m${row}\x1b[0m`);
  }
  return rows.join('\n');
}

export async function runConnectCli(options: ConnectOptions = {}): Promise<ConnectResult> {
  const result = await connectWithWeChat({ ...options, onScan: options.onScan ?? (({ qrUrl }) => {
    console.log(`Scan this QR code with WeChat:\n${terminalQr(qrUrl)}`);
  }) });
  const display = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  console.log(`Agent: ${display(result.credentials.agentName)} (@${display(result.credentials.agentSlug)})\nGroupChat: ${display(result.groupChatTitle)} (${display(result.groupChatId)})\nHandoff URL: ${result.handoffUrl}`);
  return result;
}
