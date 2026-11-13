export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Server URL must be an HTTP(S) origin without credentials, query or fragment');
  }
  if (url.pathname !== '/') throw new Error('Server URL must not contain a path');
  return url.origin;
}
export class BridgeHttpError extends Error {
  constructor(readonly status: number, path: string) { super(`Agent Bridge ${path} returned HTTP ${status}`); }
}
export async function requestJson<T>(base: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, normalizeServerUrl(base)), {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new BridgeHttpError(response.status, path.split('?')[0]!);
  return await response.json() as T;
}
