import { clientBranding } from './branding.js';
import { pairHost, runPairingCli as run } from '@nia-teams/agent-bridge-core/pairing';
import { defaultConfigDir } from './credentials.js';
export { acquireLease } from '@nia-teams/agent-bridge-core/pairing';
export type { PairOptions } from '@nia-teams/agent-bridge-core/pairing';
import type { PairOptions } from '@nia-teams/agent-bridge-core/pairing';
const defaults = () => ({ hostPrefix: 'claude-code', ...clientBranding, cliCommandName: 'nia-claude', configDir: defaultConfigDir() });
export const pairWithNiaTeams = (options: PairOptions = {}) => pairHost({ ...defaults(), ...options, configDir: options.configDir ?? defaultConfigDir() });
export const runPairingCli = (options: PairOptions = {}) => run({ ...defaults(), ...options, configDir: options.configDir ?? defaultConfigDir() });
