#!/usr/bin/env node
import { randomInt } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.NIA_MOCK_LOG) appendFileSync(process.env.NIA_MOCK_LOG, JSON.stringify({ args }) + '\n');
const value = f => args[args.indexOf(f) + 1];
const has = f => args.includes(f);
const action = args.findIndex(a => ['status', 'models', 'cdp', 'sessions'].includes(a));
const [command, subcommand, operand] = args.slice(action);
const out = x => console.log(JSON.stringify(x));
const fail = (message, result) => { if (result) out(result); console.error(message); process.exitCode = 1; };
if (command === 'status') out({ loggedIn: !process.env.NIA_MOCK_NO_LOGIN });
else if (command === 'models') {
  if (process.env.NIA_MOCK_NO_LOGIN) fail('Sign in first'); else out({ models: [{ name: 'mock' }] });
} else if (command === 'cdp') {
  if (subcommand === 'status' && process.env.NIA_MOCK_CDP !== 'ready' && !existsSync('mock-cdp-ready')) fail('unavailable', { available: false, identityMismatch: process.env.NIA_MOCK_CDP === 'wrong', error: 'wrong CDP endpoint' });
  else if (subcommand === 'launch' && process.env.NIA_MOCK_CDP === 'running' && !has('--yes')) fail('must restart; use --yes');
  else { if (subcommand === 'launch') writeFileSync('mock-cdp-ready', 'ready'); out({ available: true }); }
} else if (command === 'sessions') {
  const conversationId = subcommand === 'create' ? String(Date.now()) + String(randomInt(1000000)).padStart(6, '0') : operand;
  const runId = has('--run') ? value('--run') : String(Date.now()) + String(randomInt(1000000)).padStart(6, '0');
  if (['create', 'send'].includes(subcommand)) {
    const prompt = args.slice(args.indexOf('--') + 1).join(' ');
    if (prompt.includes('authfail')) fail('Sign in to Doubao first');
    else if (prompt.includes('malformed')) console.log('not JSON');
    else if (prompt.includes('missing-receipt')) out({ status: 'running' });
    else if (prompt.includes('hold-submit')) setTimeout(() => out({ conversationId, runId, status: 'running' }), 180);
    else out({ conversationId, runId, status: 'running' });
  } else if (subcommand === 'wait') {
    if (process.env.NIA_MOCK_WAIT === 'hold') setInterval(() => {}, 1000);
    else if (process.env.NIA_MOCK_WAIT === 'mismatch') out({ conversationId, runId: '9999999999999999999', status: 'completed', reply: { text: 'wrong reply' } });
    else if (process.env.NIA_MOCK_WAIT === 'approval') fail('waiting input', { conversationId, runId, status: 'waiting_input', pending: [{ kind: 'approval' }] });
    else if (process.env.NIA_MOCK_WAIT === 'empty') out({ conversationId, runId, status: 'completed', reply: { text: '' } });
    else out({ conversationId, runId, status: 'completed', reply: { role: 'assistant', text: 'Doubao final reply' } });
  } else if (subcommand === 'stop') out({ conversationId, runId, stopped: process.env.NIA_MOCK_STOP !== 'fail' });
  else fail('Unknown mock sessions command');
} else fail('Not a unified doubao-cli command');
