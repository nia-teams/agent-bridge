#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
if (process.env.NIA_MOCK_LOG) appendFileSync(process.env.NIA_MOCK_LOG, JSON.stringify({ args, pid: process.pid }) + '\n');
const value = flag => args[args.indexOf(flag) + 1];
if (args[0] === 'auth') {
  if (args.join(' ') !== 'auth status --verify') process.exit(9);
  const loggedIn = process.env.NIA_NATIVE_AUTH !== 'missing' || (process.env.NIA_NATIVE_AUTH_FILE && existsSync(process.env.NIA_NATIVE_AUTH_FILE));
  process.exit(loggedIn && process.env.NIA_NATIVE_VERIFY !== 'fail' ? 0 : 1);
}
if (args[0] === 'login') {
  console.log('MOCK LOCAL TERMINAL QR (not a GroupChat message)');
  if (process.env.NIA_NATIVE_LOGIN === 'fail') process.exit(2);
  if (process.env.NIA_NATIVE_AUTH_FILE) writeFileSync(process.env.NIA_NATIVE_AUTH_FILE, 'signed in');
  process.exit(0);
}
if (!args.includes('-p')) { console.error('not the official native CLI protocol'); process.exit(3); }
const prompt = value('-p');
if (prompt.includes('authfail')) { console.error('Login required'); process.exit(1); }
if (!prompt.includes('missing-marker')) console.error(JSON.stringify({ type: 'session', session_id: args.includes('--resume') ? value('--resume') : randomUUID() }));
if (prompt.includes('hold')) {
  process.on('SIGTERM', () => { if (process.env.NIA_MOCK_LOG) appendFileSync(process.env.NIA_MOCK_LOG, JSON.stringify({ signal: 'SIGTERM', pid: process.pid }) + '\n'); process.exit(0); });
  setInterval(() => {}, 1000);
} else if (prompt.includes('approval-needed') && value('--permission-mode') !== 'always_allow') {
  console.error('User input is required in ask_always mode'); process.exitCode = 1;
} else console.log('Doubao final reply');
