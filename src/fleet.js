import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import { validateConfig } from './config.js';

export async function initFleet(root, packageRoot) {
  const manifest = { agents: [{ name: 'agent-one', directory: 'agents/agent-one' }, { name: 'agent-two', directory: 'agents/agent-two' }] };
  // Reserve the manifest first so repeated initialization cannot change an existing fleet.
  await writeFile(resolve(root, 'fleet.config.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (const entry of manifest.agents) {
    const directory = resolve(root, entry.directory); await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [source, target] of [['agent.config.example.json', 'agent.config.json'], ['.env.example', '.env']]) {
      try { await writeFile(resolve(directory, target), await readFile(resolve(packageRoot, source)), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }
  return manifest;
}

export async function loadFleet(root, requireBindings = true) {
  const manifest = JSON.parse(await readFile(resolve(root, 'fleet.config.json'), 'utf8'));
  if (!Array.isArray(manifest.agents) || manifest.agents.length < 1 || manifest.agents.length > 8) throw new Error('Fleet must contain 1–8 agents.');
  const names = new Set(); const directories = new Set(); const accounts = new Set(); const agents = [];
  for (const entry of manifest.agents) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(entry.name) || names.has(entry.name) || typeof entry.directory !== 'string' || !entry.directory) throw new Error('Each fleet agent needs a unique simple name and directory.');
    const directory = await realpath(isAbsolute(entry.directory) ? entry.directory : resolve(root, entry.directory));
    if (directories.has(directory)) throw new Error('Fleet agents cannot share a directory.');
    names.add(entry.name); directories.add(directory);
    const config = validateConfig(JSON.parse(await readFile(resolve(directory, 'agent.config.json'), 'utf8')));
    const state = await new Store(directory).read();
    if (requireBindings && !state.binding?.id) throw new Error(`Connect ${entry.name} with auth in its own directory before fleet run.`);
    if (state.binding?.id && accounts.has(state.binding.id)) throw new Error('A Reddit account may appear only once in a fleet.');
    if (state.binding?.id) accounts.add(state.binding.id);
    agents.push({ name: entry.name, directory, config, state });
  }
  return agents;
}

export async function runFleet(root, cli, { publish = false, cycles = 1, spawnProcess = spawn, output = console.log, signal } = {}) {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20) throw new Error('Fleet cycles must be 1–20 per agent.');
  const agents = await loadFleet(root);
  const children = new Set(); let interrupted = false;
  const stop = () => { interrupted = true; for (const child of children) child.kill('SIGINT'); };
  signal?.addEventListener('abort', stop, { once: true });
  const env = { ...process.env };
  // Each child must obtain Reddit credentials only from its own .env.
  for (const key of Object.keys(env)) if (key.startsWith('REDDIT_')) delete env[key];
  try {
    if (signal?.aborted) throw new Error('Fleet run cancelled.');
    const results = await Promise.all(agents.map(agent => new Promise(resolveResult => {
      let child; let finished = false;
      const finish = (code, error) => {
        if (finished) return; finished = true; if (child) children.delete(child);
        resolveResult({ name: agent.name, code, ...(error ? { error } : {}) });
      };
      try {
        child = spawnProcess(process.execPath, [cli, 'run', ...(publish ? ['--publish'] : []), '--cycles', String(cycles)],
          { cwd: agent.directory, env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        for (const stream of [child.stdout, child.stderr]) {
          let buffer = '';
          stream?.setEncoding('utf8');
          stream?.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\n'); buffer = lines.pop();
            for (const line of lines) output(`[${agent.name}] ${line}`);
            if (buffer.length > 20000) { output(`[${agent.name}] ${buffer.slice(0, 20000)}`); buffer = ''; }
          });
          stream?.on('end', () => { if (buffer) output(`[${agent.name}] ${buffer}`); });
        }
        child.on('error', () => finish(1, 'Worker could not start.'));
        child.on('close', code => finish(code ?? 1));
        if (interrupted) child.kill('SIGINT');
      } catch { finish(1, 'Worker could not start.'); }
    })));
    return { results, interrupted, success: !interrupted && results.every(x => x.code === 0) };
  } finally { signal?.removeEventListener('abort', stop); }
}
