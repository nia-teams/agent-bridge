import { clientBranding } from './branding.js';
import z from '@deepseek-ai/schemastery';
import { loadCredentials } from './credentials.js';
import { BridgeClient } from './bridge-client.js';
import { normalizeServerUrl } from './http.js';
import { NiaTeamsHost } from './plugin.js';
import type { PluginConfig } from './plugin.js';
import type { HostContext } from './dsh-types.js';

export const name = 'nia-teams';
export const inject = ['agents'];
export const Config = z.object({
  configDir: z.string().description('Private nia-dsh credentials directory.'),
  serverUrl: z.string().description('Optional server origin; must match the paired credentials.'),
  cwd: z.string().description('Working directory for new GroupChat sessions.'),
  agentPreset: z.string().description('Optional Agent preset id (defaults to host default preset when agentPresets is present).'),
  agentOptions: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string() }),
  sessionAllowTools: z.array(z.string()).default([]).description('Explicit operator-preauthorized tool names. Empty by default.'),
});
/** Named function-plugin exports only: a default export prevents Cordis from seeing injection metadata. */
export async function apply(ctx: HostContext, config: PluginConfig = {}): Promise<void> {
  let disposed = false;
  let host: NiaTeamsHost | undefined;
  ctx.effect(() => async () => { disposed = true; await host?.close(); });
  const credentials = await loadCredentials(config.configDir);
  if (disposed) return;
  const configured = config.serverUrl ?? process.env.NIA_TEAMS_URL;
  if (configured && normalizeServerUrl(configured) !== normalizeServerUrl(credentials.serverUrl)) throw new Error('Server URL does not match paired credentials; run nia-dsh pair for this server');
  const bridge = new BridgeClient(credentials, { ...clientBranding, onError: error => ctx.logger.warn(`Nia Teams: ${error.message}`) });
  host = new NiaTeamsHost(ctx, bridge, config);
  // Transient network failure should not unload the plugin and defeat reconnection.
  void bridge.start().catch(() => {});
}
export { BridgeClient } from './bridge-client.js';
export { pairWithNiaTeams } from './pairing.js';
export { loadCredentials, saveCredentials } from './credentials.js';
export { stableExternalAgentThreadId } from './crypto.js';
export { NiaTeamsHost } from './plugin.js';
export type { PluginConfig } from './plugin.js';
export type * from './types.js';
