import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeClient } from './bridge-client.js';
import { configDirectory, loadCredentials } from './credentials.js';
import { pidFilename, processIdentity, readPid, removePid, signalPid, writePid } from './daemon-pid.js';
import { SessionHost, type SessionHostOptions, type TurnRunner } from './session-host.js';

/** Stop the registered daemon; undefined means no matching daemon was running. */
export async function stopSessionDaemon(configDir: string): Promise<number | undefined> {
  const dir = await configDirectory(configDir, false).catch((error: Error) => {
    if (error.message !== 'Config directory does not exist') throw error;
    return undefined;
  });
  if (!dir) return undefined;
  const path = join(dir, pidFilename);
  const record = readPid(path);
  if (!record) return undefined;
  const { pid } = record;
  if (pid === process.pid || pid === 1) throw new Error(`Refusing to signal daemon PID ${pid} from this process`);
  // Keep identity verification adjacent to the signal; Node exposes no process handle for kill.
  if (await processIdentity(pid) !== record.identity) {
    removePid(path, record);
    return undefined;
  }
  const signaled = signalPid(pid, 'SIGTERM');
  if (signaled) {
    const deadline = Date.now() + 5000;
    // Releasing the PID file is not the same as exiting. On Windows SIGTERM
    // is forceful and the daemon may not run its cleanup at all.
    while (signalPid(pid, 0)) {
      if (Date.now() >= deadline) throw new Error(`Daemon (pid ${pid}) did not stop within 5 seconds`);
      await delay(50);
    }
  }
  removePid(path, record);
  return signaled ? pid : undefined;
}

export function runSessionDaemon(runner: TurnRunner, options: SessionHostOptions): Promise<void> {
  return runBridgeDaemon(options, (bridge, onError) => new SessionHost(bridge, runner, { ...options, onError }));
}

export async function runBridgeDaemon(
  options: Pick<SessionHostOptions, 'configDir' | 'onError' | 'clientName' | 'avatar'>,
  createHost: (bridge: BridgeClient, onError: (error: Error) => void) => { start(): Promise<void>; close(): Promise<void> },
): Promise<void> {
  const onError = options.onError ?? ((error: Error) => console.error(`[${new Date().toISOString()}] ${error.message}`));
  const bridge = new BridgeClient(await loadCredentials(options.configDir), { onError, clientName: options.clientName, avatar: options.avatar });
  const path = join(await configDirectory(options.configDir, false), pidFilename);
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error('Cannot register daemon process identity');
  const record = { pid: process.pid, identity, token: randomUUID() };
  const host = createHost(bridge, onError);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    // Closing the transport first releases RPCs waiting for ready during cleanup.
    bridge.close(); await host.close();
  })();
  const interrupt = () => { void stop().catch(onError); };
  let registered = false, terminal = false;
  const closed = bridge.whenClosed().then(error => { terminal = true; return error; });
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await host.start();
    if (stopping) return;
    try { await bridge.start(); }
    catch (error) { if (!terminal) throw error; }
    // A failed new connection must not replace the registration of a live host.
    if (!terminal) {
      writePid(path, record);
      registered = true;
    }
    const error = await closed;
    if (error) throw error;
  } finally {
    try { await stop(); }
    finally {
      try { if (registered) removePid(path, record); }
      finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
    }
  }
}
