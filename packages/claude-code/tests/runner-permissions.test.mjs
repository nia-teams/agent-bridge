import assert from 'node:assert/strict';
import { sdkPermissionSuite } from '../../../tests/sdk-permission-suite.mjs';
sdkPermissionSuite('Claude', new URL('../dist/runner.js', import.meta.url), '@anthropic-ai/claude-agent-sdk', 'createClaudeRunner', 'claudeBin', options => {
  assert.equal(options.strictMcpConfig, true, 'daemon must ignore inherited MCP server configuration');
});
