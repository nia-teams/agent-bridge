import { defaultConfigDir, runConnectCli } from '@nia-teams/agent-bridge-core';

await runConnectCli({
  agentName: 'My Local Agent',
  configDir: defaultConfigDir('my-agent', 'MY_AGENT_CONFIG_DIR'),
  groupLink: process.argv[2],
});
