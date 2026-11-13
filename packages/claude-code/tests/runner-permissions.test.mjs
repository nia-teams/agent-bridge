import assert from 'node:assert/strict';
import { sdkPermissionSuite } from '../../../tests/sdk-permission-suite.mjs';
const parentMarker = process.env.NIA_CLAUDE_DAEMON;
sdkPermissionSuite('Claude', new URL('../dist/runner.js', import.meta.url), '@anthropic-ai/claude-agent-sdk', 'createClaudeRunner', 'claudeBin', options => {
  assert.equal(options.strictMcpConfig, true, 'daemon must ignore inherited MCP server configuration');
  assert.deepEqual(options.env, { ...process.env, NIA_CLAUDE_DAEMON: '1' });
  assert.equal(process.env.NIA_CLAUDE_DAEMON, parentMarker, 'runner must not mutate the parent environment');
});
