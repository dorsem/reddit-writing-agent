import { createInterface } from 'node:readline/promises';
import { readFile, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from './config.js';

export const switches = [
  ['writing', 'antiSlop', 'Edit out repetitive AI phrasing', false],
  ['writing', 'humor', 'Allow occasional dry humor', true],
  ['writing', 'philosophy', 'Reflective reasoning', true],
  ['lore', 'enabled', 'Recurring character motifs', false],
  ['safety', 'reviewAll', 'Review every draft before publication', false]
];
export function toggleSetting(config, index) {
  const entry = switches[index]; if (!entry) throw new Error('Unknown setting.');
  const [group, key, , fallback] = entry;
  config[group] ??= group === 'lore' ? { everyCycles: 7 } : {};
  config[group][key] = !(config[group][key] ?? fallback);
  return validateConfig(config);
}
export async function settings(root, config) {
  if (!process.stdin.isTTY) throw new Error('settings needs an interactive terminal; edit agent.config.json instead.');
  const file = resolve(root, 'agent.config.json'); const original = await readFile(file, 'utf8');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      console.log('\nWriting settings (local only):');
      switches.forEach(([group, key, label, fallback], i) => console.log(`${i + 1}. [${(config[group]?.[key] ?? fallback) ? 'x' : ' '}] ${label}`));
      console.log('The active editorial profile and all settings are documented in docs/voice.md.');
      const answer = (await rl.question('Number to toggle, s to save, q to cancel: ')).trim().toLowerCase();
      if (answer === 'q') return;
      if (answer !== 's') { if (/^[1-5]$/.test(answer)) toggleSetting(config, Number(answer) - 1); continue; }
      validateConfig(config);
      if (await readFile(file, 'utf8') !== original) throw new Error('Config changed in another process; reopen settings.');
      const temporary = resolve(root, `.agent-config-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(config, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      console.log('Saved locally. Restart running agents; prepare fresh drafts after a settings change.');
      return;
    }
  } finally { rl.close(); }
}
