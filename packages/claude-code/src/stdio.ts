import { clientBranding } from './branding.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { BridgeClient } from './bridge-client.js';
import { loadCredentials } from './credentials.js';
import { ChannelServer } from './channel-server.js';

/** The daemon already owns the bridge and supplies its own scoped SDK tools. */
function idleChannel() {
  const mcp = new Server({ name: 'nia-teams', version: '0.1.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return { mcp, connect: (transport: Transport) => mcp.connect(transport), close: () => mcp.close() };
}

/** Own the child process lifetime, including hosts that close stdin without signaling. */
export async function runStdioServer(configDir?: string): Promise<void> {
  // Guard before loading credentials or constructing any bridge/channel state.
  // Inherited legacy MCP configuration must remain healthy but inert in SDK children.
  const channel = process.env.NIA_CLAUDE_DAEMON === '1' ? idleChannel() : new ChannelServer(
    new BridgeClient(await loadCredentials(configDir), { ...clientBranding, onError: error => console.error(`Nia Teams: ${error.message}`) }),
  );
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true; clearInterval(watchdog);
    // A dead stdio peer must never leave a WebSocket child alive indefinitely.
    const deadline = setTimeout(() => { process.exit(0); }, 2500);
    void channel.close().catch(error => console.error(String(error))).finally(() => { clearTimeout(deadline); process.exit(0); });
  };
  const watchdog = setInterval(() => { if (process.stdin.destroyed || process.stdin.readableEnded) stop(); }, 1000);
  watchdog.unref();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, stop);
  process.stdin.once('end', stop); process.stdin.once('close', stop);
  channel.mcp.onclose = stop;
  try { await channel.connect(new StdioServerTransport()); }
  catch (error) { console.error(`Nia Teams: ${String(error)}`); stop(); }
}
