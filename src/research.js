import { requestJson } from './http.js';
import { bytesHash } from './intake.js';

export function sourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname === 'localhost' || !url.hostname.includes('.') || /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.startsWith('[') || /\.(?:local|localhost|internal)$/.test(url.hostname)) throw new Error('Source must use a public HTTPS URL without credentials.');
  url.hash = '';
  return url.href;
}

const plain = value => String(value || '').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[x]);

export async function research(config, query, fetcher = fetch, now = Date.now()) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('Search query must contain 1–300 characters.');
  const provider = config.research?.provider || 'wikipedia';
  const limit = config.research?.maxResults || 5;
  let rows;
  if (provider === 'searxng') {
    if (!config.research?.baseUrl) throw new Error('Set research.baseUrl to your SearXNG instance.');
    const url = new URL('/search', config.research.baseUrl);
    url.search = new URLSearchParams({ q: query, format: 'json', categories: 'general' }).toString();
    const { data } = await requestJson(url, {}, fetcher);
    if (!Array.isArray(data.results)) throw new Error('SearXNG JSON search is unavailable. Enable format=json on the configured instance.');
    rows = data.results.map(x => ({ title: x.title, url: x.url, excerpt: x.content }));
  } else if (provider === 'wikipedia') {
    const language = config.research?.language || 'en';
    const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
    url.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), format: 'json', utf8: '1' }).toString();
    const { data } = await requestJson(url, { headers: { 'user-agent': 'reddit-writing-agent/0.2 (source discovery)' } }, fetcher);
    if (!Array.isArray(data.query?.search)) throw new Error('Wikipedia search returned an invalid response.');
    rows = data.query.search.map(x => ({ title: x.title, url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(String(x.title).replaceAll(' ', '_'))}`, excerpt: x.snippet }));
  } else throw new Error('Unknown research provider.');
  const seen = new Set(); const sources = [];
  for (const row of rows.slice(0, 100)) {
    let url; try { url = sourceUrl(row.url); } catch { continue; }
    if (!row.title || seen.has(url)) continue;
    seen.add(url);
    sources.push({ id: `web-${bytesHash(url).slice(0, 16)}`, label: plain(row.title).slice(0, 240), url,
      excerpt: plain(row.excerpt).slice(0, 1600), provider, retrievedAt: now, evidence: 'unverified-search-excerpt' });
    if (sources.length >= limit) break;
  }
  return { query, provider, retrievedAt: now, sources, note: 'Search excerpts are unverified. Pages were not fetched. Select sources explicitly with --sources ID,ID.' };
}

export function selectSources(packet, ids, now = Date.now()) {
  if (!Array.isArray(packet?.sources) || !Array.isArray(ids) || ids.length < 1 || ids.length > 10 || new Set(ids).size !== ids.length) throw new Error('Select 1–10 distinct source IDs from research.');
  return ids.map(id => {
    const source = packet.sources.find(x => x.id === id);
    if (!source || !Number.isFinite(source.retrievedAt) || now < source.retrievedAt || now - source.retrievedAt > 86400000) throw new Error('Source is unknown or older than 24 hours. Run research again.');
    if (!/^web-[a-f0-9]{16}$/.test(source.id) || typeof source.label !== 'string' || typeof source.excerpt !== 'string') throw new Error('Invalid source snapshot.');
    return { ...source, url: sourceUrl(source.url), label: source.label.slice(0, 240), excerpt: source.excerpt.slice(0, 1600) };
  });
}
