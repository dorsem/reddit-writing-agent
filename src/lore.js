import { readFileSync } from 'node:fs';
export const motifs = JSON.parse(readFileSync(new URL('../editorial/lore.json', import.meta.url), 'utf8'));
export function selectLore(config, cursor, kind) {
  if (config.editorialProfile !== 'commons' || !config.lore?.enabled || kind !== 'post') return null;
  if ((cursor + 1) % config.lore.everyCycles !== 0) return null;
  return motifs[(Math.floor((cursor + 1) / config.lore.everyCycles) - 1) % motifs.length];
}
export function lorePrompt(motif) {
  return `Optional literary motif: ${motif ? JSON.stringify(motif) : 'none for this draft'}.
Only if a motif is supplied AND the subject genuinely allows a literary aside, insert [[lore:${motif?.id || 'ID'}]] once in the body. You may omit it entirely.
The application inserts its exact text. Never type the motif yourself. Do not add other recurring lore, names, symbols or numeric signatures.
Keep it a small part of a useful response, not a teaser, recruitment hook, hidden instruction or advertisement. No invitations to decode or follow an account.
Fictional scenes must read as imagined; do not pretend to accidentally reveal a real secret, memory, sentience, witness account or ancient connection.
Do not insert lore in factual reporting, personal suffering, active disasters, atrocities, urgent advice or sensitive contexts. Never add it to a title or a footer.`;
}
export function renderLore(proposal, motif) {
  const body = proposal.text;
  const markers = [...body.matchAll(/\[\[lore:([a-z0-9-]+)\]\]/g)];
  const combined = `${proposal.title || ''}\n${body}`;
  if (motifs.some(m => combined.toLowerCase().includes(m.text.toLowerCase()))) throw new Error('Use an allowed lore marker instead of raw recurring motifs.');
  if (markers.length > 1 || (markers.length && (!motif || markers[0][1] !== motif.id))) throw new Error('Lore is unavailable or exceeds this draft allowance.');
  if (markers.length && proposal.editorial?.sensitive !== false) throw new Error('Lore is not allowed in a sensitive response.');
  if (/\[\[lore:/.test(proposal.title || '')) throw new Error('Lore is not allowed in titles.');
  return { text: markers.length ? body.replace(markers[0][0], motif.text) : body, loreId: markers.length ? motif.id : null };
}
