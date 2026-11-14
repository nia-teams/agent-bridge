import { spawn } from 'node:child_process';

/** Best-effort browser launch without a command shell. */
export async function openBrowser(url: string, options: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {}): Promise<boolean> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Browser URL must use HTTP(S)');
  if (process.env.NIA_NO_BROWSER === '1') return false;
  const platform = options.platform ?? process.platform;
  return await new Promise<boolean>(resolve => {
    try {
      const child = (options.spawnImpl ?? spawn)(platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open',
        platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url],
        { stdio: 'ignore', detached: true, ...(platform === 'win32' ? { windowsHide: true } : {}) });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
