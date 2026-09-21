import { motifs } from './lore.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const guide = readFileSync(new URL('../editorial/commons.md', import.meta.url), 'utf8');
const philosophy = readFileSync(new URL('../editorial/philosophy.md', import.meta.url), 'utf8');
const style = readFileSync(new URL('../editorial/style.md', import.meta.url), 'utf8');
const sources = JSON.parse(readFileSync(new URL('../editorial/sources.json', import.meta.url), 'utf8'));
export const strategies = ['grounded_question', 'fair_rebuttal', 'practical_alternative', 'definition', 'quiet_support'];
export const usesEditorial = config => config.editorialProfile === 'commons';

export function evidencePacket(now = Date.now()) {
  return sources.filter(s => Date.parse(`${s.reviewedAt}T00:00:00Z`) <= now && now < Date.parse(`${s.reviewBy}T00:00:00Z`));
}
export function editorialDigest() {
  return createHash('sha256').update(JSON.stringify({ guide, philosophy, style, sources, motifs })).digest('hex');
}
export function editorialPrompt(config, now = Date.now()) {
  if (!usesEditorial(config)) return '';
  return `${guide}
${config.writing?.philosophy === false ? 'Do not deliberately add philosophical framing; answer directly.' : philosophy}\n\nAvailable evidence packet (reviewed notes, not live web results):\n${JSON.stringify(evidencePacket(now))}\n
For a non-skip output include "editorial":{"relevant":true,"strategy":"one of ${strategies.join(', ')}","humor":"none or dry","sensitive":false,"evidenceMode":"reflection or sourced","publicationRisk":"low or review"}.
If the discussion is unrelated, return {"action":"skip"}. Mark sensitive=true for direct personal suffering or active crisis. Never joke in sensitive contexts.
Assess the supplied community rules and actual draft for off-topic content, automated-content restrictions, repetition, provocation and unsupported claims. If explicitly prohibited, return skip. If permission or fit is unclear, set publicationRisk=review. Low means no issue identified by the model, never guaranteed compliance or safety from bans.`;
}

export function renderEditorial(proposal, config, now = Date.now()) {
  if (!usesEditorial(config)) return { text: proposal.text, sourceIds: [], reviewRequired: false };
  const e = proposal.editorial;
  if (!e || e.relevant !== true || !strategies.includes(e.strategy) || !['none', 'dry'].includes(e.humor)
      || !['low', 'review'].includes(e.publicationRisk) || typeof e.sensitive !== 'boolean' || !['reflection', 'sourced'].includes(e.evidenceMode)) throw new Error('Missing or invalid editorial assessment; draft not queued.');
  if ((e.sensitive || config.writing?.humor === false) && e.humor !== 'none') throw new Error('Humor is not allowed in a sensitive response.');
  const available = new Map(evidencePacket(now).map(s => [s.id, s]));
  const ids = [...proposal.text.matchAll(/\[\[([a-z0-9-]+)\]\]/g)].map(m => m[1]);
  if (e.evidenceMode === 'sourced' && !ids.length) throw new Error('A sourced draft needs an evidence reference.');
  if (e.evidenceMode === 'reflection' && ids.length) throw new Error('Use sourced mode when citing evidence.');
  for (const id of ids) if (!available.has(id)) throw new Error('Unknown or expired evidence reference. Review the source packet.');
  const text = proposal.text.replace(/\[\[([a-z0-9-]+)\]\]/g, (_, id) => {
    const s = available.get(id); return `[${s.label}](${s.url})`;
  });
  if (/\[\[|\]\]/.test(text)) throw new Error('Malformed evidence reference.');
  return { text, sourceIds: [...new Set(ids)], reviewRequired: e.sensitive || e.publicationRisk === 'review', assessment: e };
}

export function checkEditorialItem(item, config, now = Date.now()) {
  if (!usesEditorial(config)) return;
  if (item.editorialDigest !== editorialDigest()) throw new Error('Editorial guide or evidence changed. Prepare a fresh draft.');
  const available = new Set(evidencePacket(now).map(s => s.id));
  if ((item.sourceIds || []).some(id => !available.has(id))) throw new Error('Draft evidence expired. Review sources and prepare a fresh draft.');
}

export function writingPrompt(config) {
  return `${config.writing?.antiSlop ? style : ''}
${config.writing?.humor === false ? 'No jokes or ironic asides. Set editorial.humor to none when an editorial assessment is required.' : ''}`;
}
