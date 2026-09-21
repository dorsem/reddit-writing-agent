#!/usr/bin/env node
import { readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Reddit, authorize } from '../src/reddit.js';
import { Agent } from '../src/agent.js';
import { settings } from '../src/settings.js';
import { generate } from '../src/model.js';
import { checkAccount, checkClock, fingerprint, validateProposal } from '../src/policy.js';
import { demoReddit, demoModel } from '../src/demo.js';

const root = process.cwd();
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args[0] || 'help';
const output = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const publicDraft = ({ fingerprint, rulesDigest, configDigest, parentHash, ...draft }) => draft;
const has = flag => args.includes(flag);
const option = flag => args[args.indexOf(flag) + 1];

function validateArgs() {
  const forms = {
    settings: /^settings$/, preview: /^preview$/, help: /^help$/, init: /^init$/, demo: /^demo$/, auth: /^auth$/, doctor: /^doctor$/, status: /^status$/, halt: /^halt$/,
    rules: /^rules (?:@profile|[A-Za-z0-9_]{3,21})(?: --accept)?$/,
    show: /^show [a-f0-9-]{36}$/, reject: /^reject [a-f0-9-]{36}$/, publish: /^publish [a-f0-9-]{36}$/,
    resume: /^resume --ack$/, resolve: /^resolve [a-f0-9-]{36} (?:--abandon|--receipt t[13]_[a-z0-9]+)$/,
    run: /^run(?: --publish)?(?: --cycles [0-9]+)?$/
  };
  if (!forms[command]?.test((args.length ? args : ['help']).join(' '))) throw new Error('Unknown command or flags. Run help. Flags for run: --publish then --cycles N.');
}

async function main() {
  validateArgs();
  if (command === 'help') return output(`reddit-writing-agent (Node 22+)\n
  init                         Create local config and .env; never overwrite
  demo                         Offline synthetic demonstration (no account/model)
  settings                     Toggle local writing options interactively
  preview                      Generate a local sample post; no Reddit access
  auth                         OAuth login to your approved Reddit application
  doctor                       Check configuration and authenticated identity
  rules TARGET                 Read current rules; TARGET may be @profile
  rules TARGET --accept        Record your review and permission for automation
  run [--publish] [--cycles N]  Draft by default; 1–20 finite cycles
  status                       Queue and receipts (no tokens or draft bodies)
  show ID                      Read a draft
  publish ID                   Send exactly one existing draft after fresh checks
  reject ID                    Discard a draft locally
  halt                         Set a local STOP flag for subsequent sends
  resume --ack                 Clear halt after resolving the cause
  resolve ID --receipt tX_ID   Verify a receipt for an uncertain send
  resolve ID --abandon         Never retry this intent; keeps quota and fingerprint

Run from your agent directory. Read README before enabling API access. No Reddit password is requested.`);
  if (command === 'init') {
    for (const [source, target] of [['agent.config.example.json', 'agent.config.json'], ['.env.example', '.env']]) {
      try { await writeFile(resolve(root, target), await readFile(resolve(packageRoot, source)), { flag: 'wx', mode: 0o600 }); output(`Created ${target}`); }
      catch (e) { if (e.code === 'EEXIST') output(`Kept existing ${target}`); else throw e; }
    }
    return;
  }
  if (command === 'demo') {
    const dir = await mkdtemp(resolve(tmpdir(), 'reddit-agent-demo-'));
    try {
      const config = JSON.parse(await readFile(resolve(packageRoot, 'agent.config.example.json'), 'utf8'));
      config.communities = [{ name: 'writing_lab', automationAllowed: true }];
      const store = new Store(dir); const agent = new Agent(config, store, demoReddit(), demoModel);
      await store.lock(async () => { await agent.acceptRules('writing_lab', true); output(publicDraft(await agent.cycle())); });
      output('Offline demo complete. No network requests or Reddit writes.');
    } finally { await rm(dir, { recursive: true, force: true }); }
    return;
  }
  const store = new Store(root);
  if (command === 'halt') {
    await store.prepare(); await writeFile(resolve(store.dir, 'STOP'), 'Operator stopped the agent.\n', { mode: 0o600 });
    return output('STOP set. An in-flight request cannot be recalled.');
  }
  const localCommands = ['status', 'show', 'reject'];
  if (localCommands.includes(command)) return store.lock(async () => {
    const state = await store.read();
    if (command === 'status') return output({ halted: state.halted, stop: await store.stopped(), blockedUntil: state.blockedUntil,
      items: state.items.map(({ id, kind, status, createdAt, attemptedAt, receipt }) => ({ id, kind, status, createdAt, attemptedAt, receipt })) });
    const item = state.items.find(x => x.id === args[1]); if (!item) throw new Error('Draft ID not found.');
    if (command === 'show') return output(publicDraft(item));
    if (item.status !== 'draft') throw new Error('Only an unsent draft can be rejected.');
    item.status = 'discarded'; delete item.text; delete item.title; await store.write(state); output('Draft discarded locally.');
  });
  const config = await loadConfig(root);
  if (command === 'settings') return store.lock(() => settings(root, config));
  if (command === 'preview') {
    const task = { kind: 'post', community: 'local preview only', rules: [], description: 'A sample essay for the operator to review; no publication destination.', topic: config.topics[0] };
    const draft = validateProposal(await generate(config, task), 'post', config);
    return output(draft ? { title: draft.title, text: draft.text, editorial: draft.assessment, reviewRequired: draft.reviewRequired, note: 'Preview only. Not queued or published.' } : { skipped: 'Model declined this topic.' });
  }
  const reddit = new Reddit(config, store); const agent = new Agent(config, store, reddit);
  const execute = async () => store.lock(async () => {
    try {
      if (command === 'auth') {
        const existing = await store.read();
        if (existing.items.some(x => ['pending', 'unknown'].includes(x.status))) throw new Error('Resolve uncertain sends before reauthorizing.');
        await authorize(reddit); const me = await reddit.me();
        existing.binding = checkAccount(me, existing, reddit.clientId); await store.write(existing);
        return output('Account connected locally. Tokens were not printed.');
      }
      if (command === 'doctor') {
        const { me } = await agent.ready();
        return output({ oauth: 'connected', account: me.name, model: config.ollama.model || 'not configured',
          communities: config.communities.length, profilePosts: config.profilePosts, defaultMode: 'draft',
          note: 'No observed restriction is not proof of account eligibility. Model availability is checked when generating.' });
      }
      if (command === 'rules') return output(await agent.acceptRules(args[1], has('--accept')));
      if (command === 'publish') return output(await agent.publish(args[1]));
      if (command === 'run') return output(publicDraft(await agent.cycle(has('--publish'))));
      if (command === 'resume') {
        const state = await store.read();
        if (state.items.some(x => ['pending', 'unknown'].includes(x.status))) throw new Error('Resolve every uncertain send first.');
        checkClock(state, Date.now());
        if (state.blockedUntil > Date.now()) throw new Error('Rate limit cooldown is still active.');
        state.binding = checkAccount(await reddit.me(), state, reddit.clientId);
        state.halted = null; await store.write(state);
        try { await unlink(resolve(store.dir, 'STOP')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        return output('Local halt cleared. Next publish still performs all checks.');
      }
      if (command === 'resolve') {
        const state = await store.read(); const item = state.items.find(x => x.id === args[1]);
        if (!item || !['pending', 'unknown'].includes(item.status)) throw new Error('No uncertain intent with this ID.');
        if (has('--receipt')) {
          const me = await reddit.me(); checkAccount(me, state, reddit.clientId);
          const name = option('--receipt'); const actual = await reddit.info(name);
          const prefix = item.kind === 'post' ? 't3_' : 't1_';
          const actualText = item.kind === 'post' ? actual.selftext : actual.body;
          if (!name.startsWith(prefix) || actual.author?.toLowerCase() !== me.name.toLowerCase() || actual.subreddit?.toLowerCase() !== item.community.toLowerCase()
            || (item.kind === 'comment' && actual.parent_id !== item.parent) || (item.kind === 'post' && actual.title !== item.title)
            || typeof actualText !== 'string' || fingerprint(actualText).exact !== fingerprint(item.text).exact) throw new Error('Receipt does not match the exact attempted content, author and target.');
          item.status = 'sent'; item.receipt = { name }; item.resolution = 'verified receipt';
        } else { item.status = 'abandoned'; item.resolution = 'Operator abandoned intent; delivery remains unknown. Never retry this content.'; }
        delete item.text; delete item.title; await store.write(state);
        output('Intent resolved locally. Inspect the cause before resume --ack.');
      }
    } catch (error) { await agent.fail(error); throw error; }
  });
  const cycles = command === 'run' && has('--cycles') ? Number(option('--cycles')) : 1;
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20) throw new Error('--cycles must be between 1 and 20.');
  for (let i = 0; i < cycles; i++) {
    await execute();
    if (i < cycles - 1) {
      const seconds = has('--publish') ? Math.max(config.limits.pollSeconds, config.limits.minWriteIntervalSeconds) : config.limits.pollSeconds;
      output(`Cycle ${i + 1}/${cycles} complete. Waiting ${seconds}s. Ctrl+C stops the run.`);
      await sleep(seconds * 1000);
    }
  }
}

main().catch(error => { console.error(`Stopped: ${error.message}`); process.exitCode = 1; });
