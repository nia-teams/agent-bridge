import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createToolServer, ToolHttpServer } from '../dist/index.js';
const schema = { type: 'object', properties: { options: { oneOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'array', items: { type: 'integer' } }] } }, additionalProperties: false, $defs: { id: { type: 'string', pattern: '^x' } } };
const tools = [{ name: 'core', description: 'Core', inputSchema: schema }, { name: 'explicit_core', description: 'Core false', inputSchema: schema, deferLoading: false }, { name: 'future_tool', description: 'Added remotely', inputSchema: schema, deferLoading: true }];
for (const alwaysLoad of [true, false]) test(`raw MCP JSON Schema and native metadata, alwaysLoad=${alwaysLoad}`, async t => {
  const calls = [], context = { tools, signal: new AbortController().signal, callTool: async (...args) => { calls.push(args); return { content: '{"result":"already formatted"}', isError: true }; } };
  const server = createToolServer(context, alwaysLoad), client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map(t => t.name), tools.map(t => t.name));
  for (const [i, tool] of listed.entries()) {
    assert.deepEqual(tool.inputSchema, schema);
    assert.equal(tool.deferLoading, undefined);
    assert.equal(tool._meta?.['anthropic/alwaysLoad'], alwaysLoad && i < 2 ? true : undefined);
  }
  assert.deepEqual(await client.callTool({ name: 'future_tool', arguments: { options: [1, 2] } }), { content: [{ type: 'text', text: '{"result":"already formatted"}' }], isError: true });
  assert.deepEqual(calls, [['future_tool', { options: [1, 2] }]]);
  assert.equal((await client.callTool({ name: 'unknown', arguments: {} })).isError, true);
});

test('loopback MCP requires Bearer auth, preserves arbitrary tools, closes and revokes', async t => {
  const stop = new AbortController();
  const server = new ToolHttpServer({ tools, signal: stop.signal, callTool: async () => ({ content: 'plain text' }) });
  const endpoint = await server.start(); t.after(() => server.close());
  assert.equal(new URL(endpoint.url).hostname, '127.0.0.1');
  assert.equal((await fetch(endpoint.url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const client = new Client({ name: 'test', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), tools.map(t => t.name));
  assert.deepEqual((await client.callTool({ name: 'future_tool', arguments: {} })).content, [{ type: 'text', text: 'plain text' }]);
  stop.abort(); assert.equal((await fetch(endpoint.url, { method: 'POST', headers: endpoint.headers })).status, 401);
  await client.close(); await server.close(); await assert.rejects(fetch(endpoint.url));
});
