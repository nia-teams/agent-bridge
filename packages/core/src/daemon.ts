import { BridgeClient } from './bridge-client.js';
import { loadCredentials } from './credentials.js';
import { SessionHost, type SessionHostOptions, type TurnRunner } from './session-host.js';
export async function runSessionDaemon(runner: TurnRunner, options: SessionHostOptions): Promise<void> {
  const onError = options.onError ?? ((error: Error) => console.error(error.message));
  const bridge = new BridgeClient(await loadCredentials(options.configDir), { onError, clientName: options.clientName, avatar: options.avatar });
  const host = new SessionHost(bridge, runner, { ...options, onError });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    // Closing the transport first releases RPCs waiting for ready during cleanup.
    bridge.close(); await host.close();
  })();
  const interrupt = () => { void stop().catch(onError); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await host.start(); await bridge.start();
    const error = await bridge.whenClosed();
    if (error) throw error;
  } finally {
    try { await stop(); }
    finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
}
