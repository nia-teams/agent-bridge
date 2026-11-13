import { defaultConfigDir, pairHost } from '@nia-teams/agent-bridge-core';

await pairHost({
  configDir: defaultConfigDir('my-agent', 'MY_AGENT_CONFIG_DIR'),
  hostLabel: 'my-agent',
  onPairing: ({ verificationUrl }) => console.log(verificationUrl),
});
