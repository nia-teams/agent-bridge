import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient, ChannelServer, loadCredentials } from '@nia-teams/claude-code-plugin';

// For embedding only; the nia-claude mcp CLI also installs an orphan watchdog.
const channel = new ChannelServer(new BridgeClient(await loadCredentials()));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void channel.close(); });
process.stdin.once('end', () => { void channel.close(); });
await channel.connect(new StdioServerTransport());
