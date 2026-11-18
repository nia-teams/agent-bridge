import { contract } from '../packages/core/tests/helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function sdkPermissionSuite(runtime, runnerUrl, sdk, factory, binKey, assertOptions = () => {}) {
  test(`${runtime}: scoped Nia tools use canUseTool without shadowing or bypassing other approvals`, async () => {
    const require = createRequire(import.meta.url);
    let captured; let listed; let called; let deferredListed; let deferredResult;
    const definitions = [...contract.tools, { name: 'future_tool', description: 'Server-added deferred tool', inputSchema: { type: 'object', properties: { value: { enum: ['one', 'two'] } } }, deferLoading: true }];
    const key = `sdkMock_${runtime.replace(/\W/g, '')}`;
    globalThis[key] = {
      query(input) {
        captured = input.options;
        return { async *[Symbol.asyncIterator]() {
          const client = new Client({ name: 'test', version: '1.0.0' });
          const [a, b] = InMemoryTransport.createLinkedPair();
          await captured.mcpServers.nia.instance.connect(b); await client.connect(a);
          listed = (await client.listTools()).tools; called = await client.callTool({ name: 'chat_history', arguments: { limit: 1 } });
          await client.close();
          if (runtime === 'WorkBuddy') {
            const config = captured.mcpServers.nia_deferred;
            assert.equal(config.type, 'http');
            const external = new Client({ name: 'test', version: '1' });
            try { await external.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })); deferredListed = (await external.listTools()).tools; deferredResult = await external.callTool({ name: 'future_tool', arguments: { value: 'one' } }); } finally { await external.close(); }
          }
          yield { type: 'result', subtype: 'success', result: 'done' }; }, close() {} };
      },
    };
    const source = (await readFile(runnerUrl, 'utf8'))
      .replace(new RegExp(`import \\{([^}]+)\\} from '${sdk}';`), `const {$1} = globalThis[${JSON.stringify(key)}];`)
      .replace("'zod'", JSON.stringify(pathToFileURL(require.resolve('zod')).href))
      .replace("'@nia-teams/agent-bridge-core'", JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href));
    try {
      const runner = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))[factory];
      const permissions = [];
      await runner({ cwd: process.cwd(), [binKey]: fileURLToPath(new URL('./fixtures/mock-sdk-cli.mjs', import.meta.url)) })({
        ...contract, tools: definitions, deliveryId: 'test', prompt: 'hello', signal: new AbortController().signal, session: async () => {},
        callTool: async name => ({ content: name === 'future_tool' ? '{"future":true}' : '{"history":[]}', ...(name === 'future_tool' ? { isError: true } : {}) }),
        permission: async (...args) => { permissions.push(args); return { behavior: 'deny', message: 'Needs approval' }; },
      });
      assertOptions(captured);
      assert.equal(captured.systemPrompt.append, contract.systemPrompt);
      assert.deepEqual(listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), (runtime === 'Claude' ? definitions : definitions.filter(t => !t.deferLoading)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
      assert.equal(called.content[0].text, '{"history":[]}');
      for (const tool of listed) assert.equal(tool._meta?.['anthropic/alwaysLoad'], runtime === 'Claude' && tool.name !== 'future_tool' ? true : undefined);
      if (runtime === 'WorkBuddy') {
        assert.deepEqual(deferredListed.map(t => t.name), ['future_tool']);
        assert.deepEqual(deferredListed[0].inputSchema, definitions.at(-1).inputSchema);
        assert.equal(deferredListed[0].deferLoading, undefined);
        assert.deepEqual(deferredResult, { content: [{ type: 'text', text: '{"future":true}' }], isError: true });
        await assert.rejects(fetch(captured.mcpServers.nia_deferred.url));
      }
      assert.equal(captured.allowedTools, undefined);
      const signal = new AbortController().signal;
      const input = { content: 'hello' };
      for (const name of ['mcp__nia__send_message', 'mcp__nia__chat_history', 'mcp__nia__future_tool', ...(runtime === 'WorkBuddy' ? ['mcp__nia_deferred__future_tool'] : [])]) {
        assert.deepEqual(await captured.canUseTool(name, input, { signal }), { behavior: 'allow', updatedInput: input });
      }
      assert.equal(permissions.length, 0);
      for (const name of ['Bash', 'AskUserQuestion', 'mcp__other__chat_history']) {
        assert.deepEqual(await captured.canUseTool(name, input, { signal }), { behavior: 'deny', message: 'Needs approval' });
      }
      assert.equal(permissions.length, 3);
      assert.equal(permissions[0][2], signal);
    } finally { delete globalThis[key]; }
  });
}
