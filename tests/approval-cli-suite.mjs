import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export function approvalCliSuite(entry, hasBypassAlias = false) {
  const bin = entry instanceof URL ? fileURLToPath(entry) : entry;
  const cli = (...args) => exec(process.execPath, [bin, ...args], { timeout: 10_000 });
  test('start and connect advertise --require-approval and fail closed on conflicting flags', async () => {
    const { stdout } = await cli('--help');
    for (const command of ['start', 'connect']) {
      assert.match(stdout, new RegExp(`^nia-\\S+ ${command} .*\\[--require-approval\\]`, 'm'));
      for (const legacyFlag of ['--full-auto', ...(hasBypassAlias ? ['--bypass-approvals'] : [])]) {
        await assert.rejects(cli(command, '--require-approval', legacyFlag), {
          code: 1, stderr: /--require-approval cannot be combined with --full-auto/,
        });
      }
    }
  });
}
