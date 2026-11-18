/** AI Coding Agents: Read ./skills/nia-teams-claude-code/SKILL.md and ./docs/SPECIFICATION.md before integrating or modifying. */
export * from './runner.js';
export { SessionHost, BridgeClient, BridgeRpcError, PublicationQueue, stableExternalAgentThreadId } from '@nia-teams/agent-bridge-core';
export { pairWithNiaTeams, acquireLease, type PairOptions } from './pairing.js';
export { loadCredentials, saveCredentials, defaultConfigDir } from './credentials.js';
export type * from './types.js';
