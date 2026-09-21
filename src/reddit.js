import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { requestJson, RequestError, retryTime } from './http.js';
import { requireConsent } from './config.js';
import { uploadMedia, waitForMedia } from './media.js';

const OAUTH = 'https://oauth.reddit.com';
const TOKEN = 'https://www.reddit.com/api/v1/access_token';

export class Reddit {
  constructor(config, store, { env = process.env, fetcher = fetch, socketFactory } = {}) {
    requireConsent(config);
    this.config = config; this.store = store; this.fetcher = fetcher;
    this.socketFactory = socketFactory;
    this.clientId = env.REDDIT_CLIENT_ID; this.secret = env.REDDIT_CLIENT_SECRET || '';
    this.userAgent = env.REDDIT_USER_AGENT;
    if (!this.clientId || !this.userAgent) throw new Error('Set REDDIT_CLIENT_ID and REDDIT_USER_AGENT in .env.');
  }
  async exchange(params) {
    const { data } = await requestJson(TOKEN, { method: 'POST', headers: {
      authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString('base64')}`,
      'user-agent': this.userAgent, 'content-type': 'application/x-www-form-urlencoded'
    }, body: new URLSearchParams(params) }, this.fetcher);
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('OAuth token exchange failed. Check application approval and credentials.');
    return data;
  }
  async saveToken(data, old = {}) {
    const token = { clientId: this.clientId, access_token: data.access_token,
      refresh_token: data.refresh_token || old.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000, scope: data.scope || old.scope };
    if (!token.refresh_token) throw new Error('No refresh token returned. Authorize permanent access.');
    const scopes = new Set((token.scope || '').split(/[ ,]+/));
    if (!['identity', 'read', 'submit'].every(x => scopes.has(x))) throw new Error('OAuth grant requires identity, read and submit scopes.');
    await this.store.writeJson('oauth.json', token);
    return token;
  }
  async accessToken() {
    let token = await this.store.token();
    if (token.clientId !== this.clientId) throw new Error('OAuth token belongs to another app. Reauthorize explicitly.');
    if (token.expires_at <= Date.now() + 60000) token = await this.saveToken(await this.exchange({ grant_type: 'refresh_token', refresh_token: token.refresh_token }), token);
    return token.access_token;
  }
  async api(path, params = null) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path.');
    const state = await this.store.read();
    if (state.blockedUntil > Date.now()) throw new RequestError('Reddit rate limit cooldown is active.', { retryAt: state.blockedUntil });
    const access = await this.accessToken();
    const result = await requestJson(`${OAUTH}${path}`, { method: params ? 'POST' : 'GET', write: !!params,
      headers: { authorization: `Bearer ${access}`, 'user-agent': this.userAgent, ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(params ? { body: new URLSearchParams(params) } : {}) }, this.fetcher);
    const errors = result.data?.json?.errors;
    if (Array.isArray(errors) && errors.length) {
      // Never log server messages or response bodies: they can contain user data.
      const codes = errors.map(x => String(x[0]).replace(/[^A-Z0-9_]/g, '').slice(0, 50));
      throw new RequestError(`Reddit rejected request: ${codes.join(', ')}.`, {
        restriction: true,
        retryAt: codes.includes('RATELIMIT') ? retryTime(result.headers) : 0
      });
    }
    if (result.headers.has('x-ratelimit-remaining') && Number(result.headers.get('x-ratelimit-remaining')) <= 0) {
      const latest = await this.store.read(); latest.blockedUntil = retryTime(result.headers); await this.store.write(latest);
    }
    return result.data;
  }
  me() { return this.api('/api/v1/me'); }
  about(name) { return this.api(`/r/${encodeURIComponent(name)}/about.json`).then(x => x.data); }
  async rules(name) {
    const rules = await this.api(`/r/${encodeURIComponent(name)}/about/rules.json`);
    const about = await this.about(name);
    if (!Array.isArray(rules.rules) || !about?.display_name) throw new Error('Cannot read complete community rules.');
    return { rules: rules.rules.map(r => ({ title: r.short_name, text: r.description, kind: r.kind })),
      description: about.description || '', publicDescription: about.public_description || '',
      submissionType: about.submission_type, submitText: about.submit_text || '', about };
  }
  async recent(name) {
    const x = await this.api(`/r/${encodeURIComponent(name)}/new.json?limit=10&raw_json=1`);
    if (!Array.isArray(x.data?.children)) throw new Error('Cannot read community listing.');
    return x.data.children.filter(c => c.kind === 't3').map(c => c.data);
  }
  async discover(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('Search query must contain 1–300 characters.');
    const x = await this.api(`/subreddits/search?${new URLSearchParams({ q: query, limit: '10', sort: 'relevance', show_users: 'false', raw_json: '1' })}`);
    if (!Array.isArray(x.data?.children)) throw new Error('Invalid community search response.');
    return x.data.children.filter(c => c.kind === 't5' && /^[A-Za-z0-9_]{3,21}$/.test(c.data?.display_name) && !c.data.over18 && !c.data.quarantine)
      .map(({ data: d }) => ({ name: d.display_name, title: d.title, description: String(d.public_description || '').slice(0, 1500), subscribers: d.subscribers, url: `https://www.reddit.com/r/${d.display_name}/` }));
  }
  async replies(fullname, root) {
    if (!/^t[13]_[a-z0-9]+$/.test(fullname) || !/^t3_[a-z0-9]+$/.test(root)) throw new Error('Invalid conversation IDs.');
    const query = new URLSearchParams({ limit: '25', depth: '2', sort: 'new', raw_json: '1', ...(fullname.startsWith('t1_') ? { comment: fullname.slice(3) } : {}) });
    const data = await this.api(`/comments/${root.slice(3)}.json?${query}`);
    if (!Array.isArray(data?.[1]?.data?.children)) throw new Error('Cannot read conversation replies.');
    const result = [];
    const walk = (children, depth = 0) => {
      if (depth > 3 || !Array.isArray(children)) return;
      for (const node of children.slice(0, 100)) {
        if (node.kind !== 't1') continue;
        if (node.data.parent_id === fullname) result.push(node.data);
        walk(node.data.replies?.data?.children, depth + 1);
      }
    };
    walk(data[1].data.children);
    return result.slice(0, 25);
  }
  upload(image, bytes, record) { return uploadMedia(this, image, bytes, record, this.fetcher); }
  async info(fullname) {
    if (!/^t[13]_[a-z0-9]+$/.test(fullname)) throw new Error('Invalid Reddit object ID.');
    const x = await this.api(`/api/info?id=${fullname}&raw_json=1`);
    if (!Array.isArray(x.data?.children) || x.data.children.length !== 1) throw new Error('Target is unavailable.');
    return x.data.children[0].data;
  }
  async context(post) {
    const data = await this.api(`/comments/${post.id}.json?limit=5&depth=1&raw_json=1`);
    if (!Array.isArray(data) || !Array.isArray(data[1]?.data?.children)) throw new Error('Cannot read thread context.');
    return data[1].data.children.filter(x => x.kind === 't1' && x.data.body && !['[deleted]', '[removed]'].includes(x.data.body))
      .slice(0, 5).map(x => x.data.body.slice(0, 1500));
  }
  async submit(item) {
    const data = item.kind === 'comment'
      ? await this.api('/api/comment', { api_type: 'json', thing_id: item.parent, text: item.text })
      : await this.api('/api/submit', { api_type: 'json', sr: item.community, kind: item.image ? 'image' : 'self', title: item.title, text: item.text, resubmit: 'false', sendreplies: 'false', ...(item.image ? { url: item.asset.url, validate_on_submit: 'true' } : {}) });
    const receipt = item.kind === 'comment' ? data.json?.data?.things?.[0]?.data : data.json?.data;
    const name = receipt?.name;
    if (item.image && !/^t3_[a-z0-9]+$/.test(name)) return waitForMedia(receipt?.websocket_url, this.socketFactory);
    if (!new RegExp(`^${item.kind === 'comment' ? 't1' : 't3'}_[a-z0-9]+$`).test(name)) throw new RequestError('Submission response has no usable object ID.', { ambiguous: true });
    // Build URLs locally; never follow arbitrary links returned by the model or API.
    return { name, url: item.kind === 'post' ? `https://www.reddit.com/comments/${name.slice(3)}/` : `https://www.reddit.com/comments/${(item.root || item.parent).slice(3)}/_/${name.slice(3)}/` };
  }
}

export function validState(received, expected) {
  return typeof received === 'string' && Buffer.byteLength(received) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export async function authorize(reddit, print = console.log) {
  const state = randomBytes(32).toString('hex');
  const callback = new URL(reddit.config.reddit.redirectUri);
  const url = new URL('https://www.reddit.com/api/v1/authorize');
  url.search = new URLSearchParams({ client_id: reddit.clientId, response_type: 'code', state, redirect_uri: callback.href, duration: 'permanent', scope: 'identity read submit' }).toString();
  const code = await new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => { clearTimeout(timer); server.close(); error ? reject(error) : resolve(value); };
    const server = createServer((req, res) => {
      const incoming = new URL(req.url, callback.origin);
      res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      if (req.method !== 'GET' || incoming.pathname !== '/callback' || !validState(incoming.searchParams.get('state'), state)) {
        res.writeHead(400); res.end('Invalid OAuth callback.'); return;
      }
      if (incoming.searchParams.has('error') || !incoming.searchParams.get('code')) {
        res.writeHead(400); res.end('Authorization declined.'); finish(new Error('Authorization declined.')); return;
      }
      res.end('Authorization received. Return to your terminal.'); finish(null, incoming.searchParams.get('code'));
    });
    server.on('error', error => finish(new Error(`Cannot start local OAuth callback (${error.code || 'error'}).`)));
    server.listen(Number(callback.port), '127.0.0.1', () => print(`Open this URL yourself to authorize your app:\n${url.href}`));
    timer = setTimeout(() => finish(new Error('OAuth authorization timed out.')), 5 * 60 * 1000);
  });
  await reddit.saveToken(await reddit.exchange({ grant_type: 'authorization_code', code, redirect_uri: callback.href }));
}
