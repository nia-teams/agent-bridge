import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { TurnContext } from '@nia-teams/agent-bridge-core';
import { isObject } from './acp-client.js';

/** Ephemeral per-turn capabilities bind subprocess tools to a host-supplied GroupChat context. */
export class McpRelay {
  private readonly scopes = new Map<string, TurnContext>();
  private server?: Server;
  private url?: string;
  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      const reply = (status: number, value: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); } };
      if (req.method !== 'POST' || req.url !== '/tool') { reply(404, { error: 'Not found' }); return; }
      const context = this.scopes.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!context || context.signal.aborted) { reply(403, { error: 'Inactive tool scope' }); return; }
      void this.handle(req, context, res).catch(() => reply(400, { error: 'GroupChat tool failed' }));
    });
    this.server = server;
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); }
    catch (error) { this.server = undefined; throw error; }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid local MCP endpoint');
    this.url = `http://127.0.0.1:${address.port}/tool`;
  }
  register(context: TurnContext): { env: Array<{ name: string; value: string }>; revoke(): void } {
    if (!this.url) throw new Error('MCP relay is not started');
    const token = randomBytes(32).toString('base64url'); this.scopes.set(token, context);
    return { env: [{ name: 'NIA_AGY_MCP_URL', value: this.url }, { name: 'NIA_AGY_MCP_TOKEN', value: token }], revoke: () => { this.scopes.delete(token); } };
  }
  private async handle(req: AsyncIterable<Buffer>, context: TurnContext, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) throw new Error('Tool input too large'); chunks.push(chunk); }
    context.signal.throwIfAborted();
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isObject(body) || !isObject(body.arguments)) throw new Error('Invalid tool request');
    const args = body.arguments; let result: unknown;
    if (body.name === 'nia_group_chat_send_message') {
      if (Object.keys(args).some(k => k !== 'content') || typeof args.content !== 'string' || !args.content.trim()) throw new Error('Invalid send arguments');
      await context.send(args.content); result = { sent: true };
    } else if (body.name === 'nia_group_chat_history') {
      const limit = args.limit ?? 50, offset = args.offset ?? 0;
      if (Object.keys(args).some(k => !['limit', 'offset'].includes(k)) || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isInteger(offset) || Number(offset) < 0) throw new Error('Invalid history range');
      result = await context.history(Number(limit), Number(offset));
    } else throw new Error('Unknown tool');
    context.signal.throwIfAborted();
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result })); }
  }
  async close(): Promise<void> {
    this.scopes.clear(); const server = this.server; this.server = undefined; this.url = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
export async function callRelay(name: string, args: unknown, url = process.env.NIA_AGY_MCP_URL, token = process.env.NIA_AGY_MCP_TOKEN): Promise<unknown> {
  if (!url || !token) throw new Error('Missing MCP turn scope');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/tool' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid MCP loopback endpoint');
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('GroupChat tool unavailable');
  const result: unknown = await response.json();
  if (!isObject(result)) throw new Error('Invalid GroupChat tool response');
  return result.result;
}
