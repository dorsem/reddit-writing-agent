import { RequestError } from './http.js';

export function uploadDestination(value) {
  const u = new URL(value.startsWith('//') ? `https:${value}` : value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || u.pathname !== '/' || !/^reddit-uploaded-media\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(u.hostname)) throw new Error('Unexpected Reddit media upload destination.');
  return u;
}

export function mediaReceipt(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !['reddit.com', 'www.reddit.com'].includes(u.hostname) || u.username || u.password || u.port) throw new Error('Invalid image receipt URL.');
  const id = u.pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/)?.[1];
  if (!id) throw new Error('Invalid image receipt URL.');
  return { name: `t3_${id}`, url: `https://www.reddit.com/comments/${id}/` };
}

export function matchesImageReceipt(item, actual) {
  if (!item.asset?.url || !item.image) return false;
  if (actual.url === item.asset.url) return true;
  if (!/^[a-zA-Z0-9_-]+$/.test(item.asset.id)) return false;
  return actual.url === `https://i.redd.it/${item.asset.id}.${item.image.extension}`;
}

export async function waitForMedia(value, socketFactory = url => new WebSocket(url), timeout = 30000) {
  let u;
  try { u = new URL(value); } catch { throw new RequestError('Image submission has no usable receipt.', { ambiguous: true }); }
  if (u.protocol !== 'wss:' || u.username || u.password || u.port || !/(^|\.)redditmedia\.com$/.test(u.hostname)) throw new RequestError('Unrecognized image confirmation endpoint.', { ambiguous: true });
  return new Promise((resolve, reject) => {
    let socket; let done = false;
    const finish = (error, receipt) => {
      if (done) return; done = true; clearTimeout(timer);
      try { socket?.close(); } catch { /* Outcome already recorded below. */ }
      error ? reject(error) : resolve(receipt);
    };
    const uncertain = () => finish(new RequestError('Image confirmation unavailable; check Reddit before resolving this intent.', { ambiguous: true }));
    const timer = setTimeout(uncertain, timeout);
    try {
      socket = socketFactory(u.href);
      socket.addEventListener('error', uncertain);
      socket.addEventListener('close', () => { if (!done) uncertain(); });
      socket.addEventListener('message', event => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 100000) return uncertain();
          const data = JSON.parse(event.data);
          if (data.type === 'failed') return finish(new RequestError('Reddit rejected image processing.', { status: 422, restriction: true }));
          if (data.payload?.redirect) finish(null, mediaReceipt(data.payload.redirect));
        } catch { uncertain(); }
      });
    } catch { uncertain(); }
  });
}

export async function uploadMedia(reddit, image, bytes, record, fetcher = fetch) {
  const lease = await reddit.api('/api/media/asset.json', { filepath: `${image.sha256}.${image.extension}`, mimetype: image.mime });
  const destination = uploadDestination(lease.args?.action || '');
  if (!Array.isArray(lease.args?.fields) || lease.args.fields.length > 30 || typeof lease.asset?.asset_id !== 'string') throw new Error('Invalid media upload lease.');
  const form = new FormData(); const names = new Set();
  for (const field of lease.args.fields) {
    if (!field || typeof field.name !== 'string' || typeof field.value !== 'string' || field.name === 'file' || names.has(field.name)) throw new Error('Invalid media lease fields.');
    names.add(field.name); form.append(field.name, field.value);
  }
  const key = form.get('key');
  if (typeof key !== 'string' || !/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.split('/').includes('..') || key.startsWith('/')) throw new Error('Invalid media asset key.');
  const asset = { id: lease.asset.asset_id, url: `${destination.origin}/${key}` };
  await record('uploading', asset);
  form.append('file', new Blob([bytes], { type: image.mime }), `${image.sha256}.${image.extension}`);
  let result;
  try { result = await fetcher(destination.href, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(60000) }); }
  catch { throw new Error('Media upload outcome is unknown; no post was submitted.'); }
  if (!result.ok) throw new Error(`Media upload failed with HTTP ${result.status}; no post was submitted.`);
  await result.body?.cancel();
  await record('uploaded', asset);
  return asset;
}
