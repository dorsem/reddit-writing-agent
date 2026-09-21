import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadEnv(root) {
  let text;
  try { text = await readFile(resolve(root, '.env'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

export function validateConfig(c) {
  if (c.editorialProfile !== undefined && !["none", "commons"].includes(c.editorialProfile)) throw new Error("Config: unknown editorialProfile.");
  if (c.lore !== undefined && (typeof c.lore.enabled !== 'boolean' || !Number.isInteger(c.lore.everyCycles) || c.lore.everyCycles < 4 || c.lore.everyCycles > 100)) throw new Error('Config: lore needs enabled and everyCycles between 4 and 100.');
  for (const k of ['mission', 'voice', 'language', 'disclosure']) {
    if (typeof c[k] !== 'string' || !c[k].trim()) throw new Error(`Config: ${k} must be a nonempty string.`);
  }
  if (!Array.isArray(c.topics) || !c.topics.length || c.topics.some(x => typeof x !== 'string' || !x.trim())) throw new Error('Config: provide topics.');
  if (!Array.isArray(c.communities)) throw new Error('Config: communities must be an array.');
  const names = new Set();
  for (const community of c.communities) {
    if (!/^[A-Za-z0-9_]{3,21}$/.test(community.name)) throw new Error('Config: invalid community name (omit r/).');
    if (names.has(community.name.toLowerCase())) throw new Error('Config: duplicate community.');
    names.add(community.name.toLowerCase());
    if (typeof community.automationAllowed !== 'boolean') throw new Error('Config: set automationAllowed for each community.');
  }
  for (const k of ['comments', 'posts']) if (typeof c.actions?.[k] !== 'boolean') throw new Error(`Config: actions.${k} must be boolean.`);
  if (typeof c.profilePosts !== 'boolean') throw new Error('Config: profilePosts must be boolean.');
  for (const k of ['apiApproved', 'appRegistered', 'accountEligible']) if (typeof c.permissions?.[k] !== 'boolean') throw new Error(`Config: permissions.${k} must be boolean.`);
  const bounds = { maxWritesPerDay: [1, 20], minWriteIntervalSeconds: [60, 604800], pollSeconds: [60, 86400], maxDrafts: [1, 200], maxBodyChars: [100, 10000] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = c.limits?.[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Config: limits.${key} must be ${min}–${max}.`);
  }
  if (typeof c.ollama?.model !== 'string') throw new Error('Config: provide ollama.model.');
  const modelUrl = new URL(c.ollama.baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(modelUrl.hostname);
  if (modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash || modelUrl.pathname !== '/') throw new Error('Config: Ollama URL must be an origin without credentials.');
  if ((!local && (!c.ollama.allowRemote || modelUrl.protocol !== 'https:')) || !['https:', 'http:'].includes(modelUrl.protocol)) throw new Error('Config: remote Ollama requires HTTPS and allowRemote=true.');
  const callback = new URL(c.reddit.redirectUri);
  if (callback.hostname !== '127.0.0.1' || callback.protocol !== 'http:' || !callback.port || callback.pathname !== '/callback' || callback.search || callback.hash || callback.username || callback.password) throw new Error('Config: OAuth redirect must be http://127.0.0.1:PORT/callback.');
  return c;
}

export async function loadConfig(root) {
  await loadEnv(root);
  try { return validateConfig(JSON.parse(await readFile(resolve(root, 'agent.config.json'), 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('Run init, then edit agent.config.json.'); throw e; }
}

export function requireConsent(c) {
  if (!Object.values(c.permissions).every(v => v === true)) throw new Error('Reddit access is disabled. Obtain API approval, register your app and confirm account eligibility in local config.');
}
