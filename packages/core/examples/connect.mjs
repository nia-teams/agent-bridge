import { BridgeClient, defaultConfigDir, loadCredentials } from '@nia-teams/agent-bridge-core';

const configDir = defaultConfigDir('my-agent', 'MY_AGENT_CONFIG_DIR');
const bridge = new BridgeClient(await loadCredentials(configDir), {
  onError: error => console.error(error.message),
});
bridge.onThreadMessage(async frame => {
  await bridge.rpc('group_chat.send_message', {
    sessionId: frame.sessionId,
    toolCallId: frame.deliveryId,
    content: 'Received',
  });
});
bridge.onThreadCancel(() => {});
bridge.onCardAction(() => {});
bridge.onReady(frame => console.log('Connected:', frame.agent.slug));
process.once('SIGINT', () => bridge.close());
process.once('SIGTERM', () => bridge.close());
await bridge.start();
