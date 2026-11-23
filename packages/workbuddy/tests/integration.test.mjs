import { sdkIntegrationSuite } from '../../../tests/sdk-integration-suite.mjs';
import { createWorkBuddyRunner } from '../dist/runner.js';
sdkIntegrationSuite('WorkBuddy', options => createWorkBuddyRunner({ model: 'glm-5.3', ...options }), 'codebuddyBin', 'workbuddy.approval');
