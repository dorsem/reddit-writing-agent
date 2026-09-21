import { renderLore } from './lore.js';
import { renderEditorial } from './editorial.js';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const configHash = c => hash(c);
export const rulesHash = rules => hash({ rules: rules.rules, description: rules.description, publicDescription: rules.publicDescription, submissionType: rules.submissionType, submitText: rules.submitText });

export function fingerprint(text) {
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const normalized = words.join(' ');
  const shingles = new Set();
  for (let i = 0; i <= words.length - 3; i++) shingles.add(hash(words.slice(i, i + 3).join(' ')));
  return { exact: hash(normalized), shingles: [...shingles] };
}

export function duplicate(a, b) {
  if (a.exact === b.exact) return true;
  if (Math.min(a.shingles.length, b.shingles.length) < 5) return false;
  const right = new Set(b.shingles);
  const intersection = a.shingles.filter(x => right.has(x)).length;
  return intersection / Math.max(1, Math.min(a.shingles.length, b.shingles.length)) >= 0.8;
}

export function validateProposal(p, kind, c, lore = null) {
  if (!p || typeof p !== 'object' || !['skip', kind].includes(p.action)) throw new Error('Model returned an invalid action.');
  if (p.action === 'skip') return null;
  if (typeof p.text !== 'string' || p.text.trim().length < 20) throw new Error('Model returned an empty or too short draft.');
  if (p.text.length + c.disclosure.length + 6 > c.limits.maxBodyChars) throw new Error('Draft exceeds configured length.');
  if (kind === 'post' && (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 300)) throw new Error('Invalid post title.');
  // The model may cite trusted source IDs, but cannot supply its own URLs or mentions.
  if (/https?:|www\.|(?:^|\s)\/?[ur]\//i.test(p.text + ' ' + (p.title || ''))) throw new Error('Draft includes a raw link or mention; use approved source markers.');
  const literary = c.editorialProfile === 'commons' ? renderLore(p, lore) : { text: p.text, loreId: null };
  const rendered = renderEditorial({ ...p, text: literary.text }, c);
  const text = `${rendered.text.trim()}\n\n---\n${c.disclosure}`;
  if (text.length > c.limits.maxBodyChars) throw new Error('Draft including citations exceeds configured length.');
  return { ...rendered, loreId: literary.loreId, title: kind === 'post' ? p.title.trim() : '', body: p.text.trim(), text };
}

export function checkAccount(me, state, clientId) {
  if (!me?.id || !me?.name) throw new Error('Account identity is unavailable.');
  if (me.is_suspended === true || me.is_banned === true) throw new Error('Account restriction reported by Reddit. Stop and review the account notice.');
  if (state.binding && (state.binding.id !== me.id || state.binding.clientId !== clientId)) throw new Error('Account/app mismatch. This journal cannot be reused for another identity.');
  return { id: me.id, clientId };
}

export function checkCommunity(rules, target, me) {
  const about = rules.about;
  if (!target.automationAllowed) throw new Error('Automation is not enabled for this target.');
  if (!about || about.user_is_banned === true || about.quarantine === true || about.over18 === true || ['private', 'archived', 'restricted', 'gold_restricted', 'gold_only'].includes(about.subreddit_type)) throw new Error('Community is unavailable, restricted, quarantined or mature.');
  if (about.display_name.toLowerCase().startsWith('u_') && about.display_name.toLowerCase() !== `u_${me.name}`.toLowerCase()) throw new Error('Profile posts are restricted to the authenticated account.');
}

export function checkParent(post, item, me, now = Date.now()) {
  if (post.name !== item.parent || post.subreddit?.toLowerCase() !== item.community.toLowerCase()) throw new Error('Parent target does not match draft.');
  if (post.locked || post.archived || post.over_18 || post.stickied || post.removed_by_category || ['[removed]', '[deleted]'].includes(post.selftext) || !post.author || ['[deleted]', me.name.toLowerCase()].includes(post.author.toLowerCase())) throw new Error('Thread is no longer eligible for a reply.');
  if (!Number.isFinite(post.created_utc) || now / 1000 - post.created_utc > 86400) throw new Error('Thread is older than 24 hours.');
}

export function checkClock(state, now) {
  if (now < state.lastClock) throw new Error('System clock moved backwards; restore the clock before continuing.');
  state.lastClock = now;
}

export function checkBudget(state, c, now) {
  if (state.blockedUntil > now) throw new Error('Reddit rate limit cooldown is still active.');
  const attempted = state.items.filter(x => Number.isFinite(x.attemptedAt));
  if (attempted.filter(x => x.attemptedAt > now - 86400000).length >= c.limits.maxWritesPerDay) throw new Error('Rolling 24-hour write budget reached.');
  if (attempted.some(x => now - x.attemptedAt < c.limits.minWriteIntervalSeconds * 1000)) throw new Error('Configured write interval has not elapsed.');
}
