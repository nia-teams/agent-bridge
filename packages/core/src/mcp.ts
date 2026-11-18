import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BridgeToolDefinition } from './types.js';
import type { ToolCallResult } from './session-host.js';

export interface CollaborationTools {
  tools: BridgeToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  signal: AbortSignal;
}
/** Serve the handshake's JSON Schemas verbatim, without a lossy Zod conversion. */
export function createToolServer(context: CollaborationTools, alwaysLoad = false): Server {
  const server = new Server({ name: 'nia', version: '0.3.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: context.tools.map(({ name, description, inputSchema, deferLoading }) => ({
    name, description, inputSchema: inputSchema as { type: 'object'; [key: string]: unknown },
    ...(alwaysLoad && !deferLoading ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      context.signal.throwIfAborted();
      if (!context.tools.some(tool => tool.name === params.name)) throw new Error('Unknown collaboration tool');
      const result = await context.callTool(params.name, params.arguments ?? {});
      return { content: [{ type: 'text' as const, text: result.content }], ...(result.isError ? { isError: true } : {}) };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String(error) }] }; }
  });
  return server;
}

/** Authenticated, per-turn, stateless loopback MCP transport for external-MCP hosts. */
export class ToolHttpServer {
  private server?: HttpServer;
  private readonly connections = new Set<Server>();
  private readonly token = randomBytes(32).toString('base64url');
  constructor(private readonly context: CollaborationTools) {}
  async start(): Promise<{ type: 'http'; url: string; headers: { Authorization: string } }> {
    if (this.server) throw new Error('MCP endpoint already started');
    const server = createServer((req, res) => {
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      if (req.headers.authorization !== `Bearer ${this.token}` || this.context.signal.aborted) { res.writeHead(401).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const mcp = createToolServer(this.context);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      this.connections.add(mcp);
      res.on('close', () => { this.connections.delete(mcp); void transport.close(); void mcp.close(); });
      void (async () => {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) throw new Error('Tool input too large'); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); void transport.close(); void mcp.close(); this.connections.delete(mcp); });
    });
    this.server = server;
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); }
    catch (error) { this.server = undefined; server.close(); throw error; }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid local MCP endpoint');
    return { type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${this.token}` } };
  }
  async close(): Promise<void> {
    const server = this.server; this.server = undefined;
    await Promise.all([...this.connections].map(connection => connection.close())); this.connections.clear();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
