import { sdkIntegrationSuite } from '../../../tests/sdk-integration-suite.mjs';
import { createWorkBuddyRunner } from '../dist/runner.js';
sdkIntegrationSuite('WorkBuddy', createWorkBuddyRunner, 'codebuddyBin', 'workbuddy.approval');
