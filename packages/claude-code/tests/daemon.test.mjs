import { sdkIntegrationSuite } from '../../../tests/sdk-integration-suite.mjs';
import { createClaudeRunner } from '../dist/runner.js';
sdkIntegrationSuite('Claude Code', createClaudeRunner, 'claudeBin', 'claude_code.permission');
