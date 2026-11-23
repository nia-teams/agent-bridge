import assert from 'node:assert/strict';
import { sdkPermissionSuite } from '../../../tests/sdk-permission-suite.mjs';
sdkPermissionSuite('WorkBuddy', new URL('../dist/runner.js', import.meta.url), '@tencent-ai/agent-sdk', 'createWorkBuddyRunner', 'codebuddyBin', options => assert.equal(options.model, 'glm-5.3'), { model: 'glm-5.3' });
