export class RequestError extends Error {
  constructor(message, { status = 0, retryAt = 0, ambiguous = false, restriction = false } = {}) {
    super(message); Object.assign(this, { status, retryAt, ambiguous, restriction });
  }
}

export function retryTime(headers, now = Date.now()) {
  const value = headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  return now + (Number.isFinite(reset) && reset > 0 ? reset : 900) * 1000;
}

export async function requestJson(url, options = {}, fetcher = fetch) {
  const { write = false, timeout = 30000, ...init } = options;
  let response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
  catch { throw new RequestError('Network request failed; no automatic retry.', { ambiguous: write }); }
  if (!response.ok) {
    throw new RequestError(`HTTP ${response.status}; request stopped.`, {
      status: response.status,
      retryAt: response.status === 429 ? retryTime(response.headers) : 0,
      ambiguous: write && response.status >= 500,
      restriction: [401, 403].includes(response.status)
    });
  }
  let data;
  try { data = await response.json(); }
  catch { throw new RequestError('Invalid JSON response.', { ambiguous: write }); }
  return { data, headers: response.headers };
}
