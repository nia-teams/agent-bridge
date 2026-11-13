type Desktop = 'work' | 'doubao';
interface Target { type?: string; url?: string; webSocketDebuggerUrl?: string }
interface Cookie { name: string; value: string; domain: string; expires?: number }
export function desktopEndpoint(backend: Desktop): string {
  let endpoint: URL;
  try { endpoint = new URL(process.env.DOUBAO_CDP_ENDPOINT || `http://127.0.0.1:${backend === 'work' ? 9226 : 9225}`); }
  catch { throw new Error('Invalid local Doubao CDP endpoint.'); }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Doubao CDP must be a local HTTP endpoint without credentials/query parameters.');
  }
  return endpoint.origin;
}
/** Browser cookies stay in memory; never include responses or low-level errors in diagnostics. */
export async function desktopCookies(backend: Desktop, signal?: AbortSignal): Promise<string> {
  const app = backend === 'work' ? 'DoubaoWork.app' : 'Doubao.app';
  const endpoint = desktopEndpoint(backend), scheme = backend === 'work' ? 'doubaowork:' : 'doubao:';
  const budget = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
  const loginError = () => new Error(`Sign in inside ${app}, finish any login screen, and retry nia-doubao start. No QR login is performed in Nia Teams.`);
  let targets: Target[];
  try {
    const response = await fetch(`${endpoint}/json/list`, { signal: budget });
    if (!response.ok) throw new Error();
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error();
    targets = data as Target[];
  } catch { signal?.throwIfAborted(); throw new Error(`Unable to inspect ${app} CDP; start it with remote debugging enabled and retry.`); }
  const parsed = targets.map(target => { try { return { target, url: new URL(target.url || '') }; } catch { return undefined; } });
  if (parsed.some(entry => entry?.url.hostname === `${scheme.slice(0, -1)}-login` && /^\/login(?:\/|$)/.test(entry.url.pathname))) throw loginError();
  const entry = parsed.find(entry => entry?.url.protocol === scheme && entry.url.hostname === `${scheme.slice(0, -1)}-chat` && entry.target.type === 'page');
  if (!entry?.target.webSocketDebuggerUrl) throw new Error(`No authenticated ${app} chat target at the selected CDP endpoint; open the app's chat window and sign in.`);
  let websocket: URL;
  try {
    websocket = new URL(entry.target.webSocketDebuggerUrl);
    const origin = new URL(endpoint);
    if (websocket.protocol !== 'ws:' || websocket.hostname !== origin.hostname || websocket.port !== origin.port || websocket.username || websocket.password) throw new Error();
  } catch { throw new Error(`Invalid ${app} CDP WebSocket target; select the correct local endpoint.`); }
  const cookies = await new Promise<Cookie[]>((resolve, reject) => {
    const socket = new WebSocket(websocket.href);
    let done = false;
    const finish = (error?: Error, value?: Cookie[]) => {
      if (done) return; done = true;
      budget.removeEventListener('abort', aborted);
      socket.close();
      if (error) reject(error); else resolve(value || []);
    };
    const failure = () => new Error(`Unable to read ${app} CDP cookies; confirm the app is signed in and retry.`);
    const aborted = () => finish(failure());
    budget.addEventListener('abort', aborted, { once: true });
    socket.addEventListener('open', () => { if (!done) socket.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' })); });
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error || !Array.isArray(message.result?.cookies)) throw new Error();
        finish(undefined, message.result.cookies);
      } catch { finish(failure()); }
    });
    socket.addEventListener('error', () => finish(failure()));
    socket.addEventListener('close', () => { if (!done) finish(failure()); });
    if (budget.aborted) aborted();
  });
  signal?.throwIfAborted();
  const usable = cookies.filter(cookie => typeof cookie.domain === 'string' && (cookie.domain === 'doubao.com' || cookie.domain.endsWith('.doubao.com'))
    && typeof cookie.name === 'string' && /^[\w!#$%&'*+.^`|~-]+$/.test(cookie.name)
    && typeof cookie.value === 'string' && !/[;\r\n]/.test(cookie.value)
    && (!cookie.expires || cookie.expires < 0 || cookie.expires * 1000 > Date.now()));
  if (!usable.some(cookie => ['sessionid', 'sid_tt'].includes(cookie.name) && cookie.value.trim())) throw loginError();
  return usable.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}
