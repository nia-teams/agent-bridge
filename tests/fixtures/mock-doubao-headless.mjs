import { currentApp } from 'doubao-cli/src/app.mjs';
import { randomInt, createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
export async function executeHeadless(options, { confirmFullAccess }) {
  if (currentApp().id !== 'headless') throw new Error('Wrong programmatic app context');
  const log = value => { if (process.env.NIA_MOCK_LOG) appendFileSync(process.env.NIA_MOCK_LOG, JSON.stringify(value) + '\n'); };
  const fullAccess = options.permission === 'FullAccess' ? await confirmFullAccess(options.workspace) : false;
  log({ args: options.__args, fullAccess, cookieHash: process.env.DOUBAO_HEADLESS_COOKIE ? createHash('sha256').update(process.env.DOUBAO_HEADLESS_COOKIE).digest('hex') : null });
  const prompt = options.args.at(-1);
  if (prompt.includes('authfail')) throw new Error('Sign in; secret-cookie-do-not-leak');
  if (prompt.includes('malformed')) return null;
  if (prompt.includes('missing-receipt')) return { status: 'completed', reply: { text: 'unsafe reply' } };
  if (options.permission === 'FullAccess' && !fullAccess) throw new Error('No full access consent');
  const conversationId = options.args[1] === 'send' ? options.args[2] : String(Date.now()) + String(randomInt(1000000)).padStart(6, '0');
  const runId = String(Date.now()) + String(randomInt(1000000)).padStart(6, '0');
  if (prompt.includes('hold-submit')) await new Promise(resolve => setTimeout(resolve, 180));
  const accepted = { conversationId, runId, status: 'running' };
  options.onAccepted(accepted);
  if (process.env.NIA_MOCK_WAIT === 'hold') return new Promise(() => { setInterval(() => {}, 1000); });
  if (process.env.NIA_MOCK_WAIT === 'approval') return { ...accepted, status: 'waiting_input' };
  if (process.env.NIA_MOCK_WAIT === 'mismatch') return { ...accepted, runId: '9999999999999999999', status: 'completed', reply: { text: 'wrong reply' } };
  return { ...accepted, status: 'completed', reply: { text: process.env.NIA_MOCK_WAIT === 'empty' ? '' : 'Doubao final reply' } };
}
