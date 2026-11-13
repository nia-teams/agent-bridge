import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callRelay } from './mcp-relay.js';

const server = new Server({ name: 'nia-teams', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'nia_group_chat_send_message', description: 'Publish an interim message to this GroupChat', inputSchema: { type: 'object', properties: { content: { type: 'string', minLength: 1 } }, required: ['content'], additionalProperties: false } },
  { name: 'nia_group_chat_history', description: 'Read older messages in this GroupChat', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await callRelay(params.name, params.arguments ?? {})) }] }; }
  catch { return { isError: true, content: [{ type: 'text', text: 'GroupChat tool unavailable for this turn or arguments' }] }; }
});
await server.connect(new StdioServerTransport());
