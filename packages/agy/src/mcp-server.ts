import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callRelay } from './mcp-relay.js';

const server = new Server({ name: 'nia-teams', version: '0.3.2' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: JSON.parse(process.env.NIA_AGY_MCP_TOOLS ?? '[]') }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try { const result = await callRelay(params.name, params.arguments ?? {}); return { ...(result.isError ? { isError: true } : {}), content: [{ type: 'text', text: result.content }] }; }
  catch { return { isError: true, content: [{ type: 'text', text: 'GroupChat tool unavailable for this turn or arguments' }] }; }
});
await server.connect(new StdioServerTransport());
