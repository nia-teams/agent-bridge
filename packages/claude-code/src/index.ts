/** AI Coding Agents: Read ./skills/nia-teams-claude-code/SKILL.md and ./docs/SPECIFICATION.md before integrating or modifying. */
export { ChannelServer, PermissionRequestSchema, formatThread } from './channel-server.js';
export { BridgeClient, BridgeRpcError } from './bridge-client.js';
export { pairWithNiaTeams, acquireLease } from './pairing.js';
export type { PairOptions } from './pairing.js';
export { loadCredentials, saveCredentials, defaultConfigDir } from './credentials.js';
export { stableExternalAgentThreadId } from './crypto.js';
export { PublicationQueue } from './publications.js';
export type * from './types.js';
