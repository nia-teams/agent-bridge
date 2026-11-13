import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function sdkPermissionSuite(runtime, runnerUrl, sdk, factory, binKey, assertOptions = () => {}) {
  test(`${runtime}: scoped Nia tools use canUseTool without shadowing or bypassing other approvals`, async () => {
    const require = createRequire(import.meta.url);
    let captured;
    const key = `sdkMock_${runtime.replace(/\W/g, '')}`;
    globalThis[key] = {
      query(input) {
        captured = input.options;
        return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', result: 'done' }; }, close() {} };
      },
      tool: () => ({}), createSdkMcpServer: () => ({ instance: { async close() {} } }),
    };
    const source = (await readFile(runnerUrl, 'utf8'))
      .replace(new RegExp(`import \\{([^}]+)\\} from '${sdk}';`), `const {$1} = globalThis[${JSON.stringify(key)}];`)
      .replace("'zod'", JSON.stringify(pathToFileURL(require.resolve('zod')).href))
      .replace("'@nia-teams/agent-bridge-core'", JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href));
    try {
      const runner = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))[factory];
      const permissions = [];
      await runner({ cwd: process.cwd(), [binKey]: fileURLToPath(new URL('./fixtures/mock-sdk-cli.mjs', import.meta.url)) })({
        prompt: 'hello', signal: new AbortController().signal, session: async () => {},
        permission: async (...args) => { permissions.push(args); return { behavior: 'deny', message: 'Needs approval' }; },
      });
      assertOptions(captured);
      assert.equal(captured.allowedTools, undefined);
      const signal = new AbortController().signal;
      const input = { content: 'hello' };
      for (const name of ['mcp__nia__nia_group_chat_send_message', 'mcp__nia__nia_group_chat_history']) {
        assert.deepEqual(await captured.canUseTool(name, input, { signal }), { behavior: 'allow', updatedInput: input });
      }
      assert.equal(permissions.length, 0);
      for (const name of ['Bash', 'AskUserQuestion', 'mcp__nia__unknown_tool', 'mcp__other__nia_group_chat_history']) {
        assert.deepEqual(await captured.canUseTool(name, input, { signal }), { behavior: 'deny', message: 'Needs approval' });
      }
      assert.equal(permissions.length, 4);
      assert.equal(permissions[0][2], signal);
    } finally { delete globalThis[key]; }
  });
}
