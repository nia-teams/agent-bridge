import { sdkPermissionSuite } from '../../../tests/sdk-permission-suite.mjs';
sdkPermissionSuite('WorkBuddy', new URL('../dist/runner.js', import.meta.url), '@tencent-ai/agent-sdk', 'createWorkBuddyRunner', 'codebuddyBin');
