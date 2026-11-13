import { defaultConfigDir as coreDir, saveCredentials as save, loadCredentials as load } from '@nia-teams/agent-bridge-core/credentials';
import type { Credentials } from './types.js';
export const defaultConfigDir = () => coreDir('nia-teams-claude-code', 'NIA_CLAUDE_CONFIG_DIR');
export const saveCredentials = (credentials: Credentials, configDir = defaultConfigDir()) => save(credentials, configDir);
export const loadCredentials = (configDir = defaultConfigDir()) => load(configDir);
