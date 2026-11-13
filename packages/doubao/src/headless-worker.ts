import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// One foreground worker per turn owns the upstream local runtime until --wait
// completes. Cookies arrive only in env; prompts/consent travel over private IPC.
const driverRequire = createRequire(import.meta.url);
function publicResult(value: any) {
  return { conversationId: value?.conversationId, runId: value?.runId,
    status: ['running', 'waiting_input', 'completed', 'failed', 'cancelled', 'unknown'].includes(value?.status) ? value.status : 'unknown',
    reply: typeof value?.reply?.text === 'string' && Buffer.byteLength(value.reply.text) <= 480 * 1024 ? { text: value.reply.text } : null };
}
process.once('message', async (request: any) => {
  let message;
  try {
    const { parseOptions } = await import(pathToFileURL(driverRequire.resolve('doubao-cli/src/cli.mjs')).href);
    const { executeHeadless } = await import(pathToFileURL(driverRequire.resolve('doubao-cli/src/headless.mjs')).href);
    const { withApp, resolvePlatform } = await import(pathToFileURL(driverRequire.resolve('doubao-cli/src/app.mjs')).href);
    const options = parseOptions(['--platform', 'headless', '--json', ...request.args]);
    options.onAccepted = (result: unknown) => process.send?.({ type: 'accepted', result: publicResult(result) });
    const result = await withApp(resolvePlatform('headless'), () => executeHeadless(options, { confirmFullAccess: async () => request.fullAuto === true }));
    message = { type: 'result', result: publicResult(result) };
  } catch (error: any) {
    // Never serialize upstream errors, causes, request bodies, cookies or headers.
    message = { type: 'failed', result: publicResult(error?.result) };
  }
  process.send?.(message, () => process.disconnect?.());
});
