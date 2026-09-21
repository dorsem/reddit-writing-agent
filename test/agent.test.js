import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Agent } from '../src/agent.js';
import { demoReddit, demoModel } from '../src/demo.js';
import { RequestError, requestJson, retryTime } from '../src/http.js';
import { checkBudget, checkClock, duplicate, fingerprint, validateProposal } from '../src/policy.js';
import { validateConfig, requireConsent } from '../src/config.js';
import { validState, Reddit } from '../src/reddit.js';

const base = JSON.parse(await readFile(new URL('../agent.config.example.json', import.meta.url), 'utf8'));
async function setup(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'reddit-agent-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = structuredClone(base); config.communities = [{ name: 'writing_lab', automationAllowed: true }];
  const store = new Store(root); const reddit = demoReddit(); let writes = 0;
  reddit.submit = async item => { writes++; return { name: 't1_receipt', url: 'https://www.reddit.com/comments/demo1/_/receipt/' }; };
  const agent = new Agent(config, store, reddit, demoModel);
  await agent.acceptRules('writing_lab', true);
  return { root, config, store, reddit, agent, writes: () => writes };
}

test('offline cycle drafts without publishing; explicit send persists intent before network and receipt after', async t => {
  const x = await setup(t); const draft = await x.agent.cycle(); assert.equal(x.writes(), 0);
  x.reddit.submit = async () => {
    const saved = await x.store.read(); assert.equal(saved.items[0].status, 'pending'); assert.ok(saved.items[0].attemptedAt);
    return { name: 't1_receipt' };
  };
  await x.agent.publish(draft.id);
  const saved = await x.store.read(); assert.equal(saved.items[0].status, 'sent'); assert.equal(saved.items[0].text, undefined);
  await assert.rejects(x.agent.publish(draft.id), /unsent draft/);
});

test('accepted request with lost response stays unknown across restart, config change and resume attempts', async t => {
  const x = await setup(t); const draft = await x.agent.cycle(); let attempts = 0;
  x.reddit.submit = async () => { attempts++; throw new RequestError('Lost response', { ambiguous: true }); };
  await assert.rejects(x.agent.publish(draft.id), /Lost response/);
  assert.equal((await x.store.read()).items[0].status, 'unknown');
  x.config.limits.maxWritesPerDay = 20;
  const restarted = new Agent(x.config, x.store, x.reddit, demoModel);
  await assert.rejects(restarted.cycle(true), /unresolved/); assert.equal(attempts, 1);
});

test('crash before send leaves pending, consumes budget and cannot silently resume', async t => {
  const x = await setup(t); const draft = await x.agent.cycle();
  const state = await x.store.read(); state.items[0].status = 'pending'; state.items[0].attemptedAt = Date.now(); await x.store.write(state);
  await assert.rejects(x.agent.publish(draft.id), /unresolved/); assert.equal(x.writes(), 0);
  assert.throws(() => checkBudget(state, { ...x.config, limits: { ...x.config.limits, maxWritesPerDay: 1 } }, Date.now()), /budget/);
});

test('failure persisting successful receipt leaves pending on disk and prevents a second request', async t => {
  const x = await setup(t); const draft = await x.agent.cycle(); const write = x.store.write.bind(x.store);
  x.store.write = async s => { if (s.items.some(i => i.status === 'sent')) throw new Error('disk full'); return write(s); };
  await assert.rejects(x.agent.publish(draft.id), /disk full/); assert.equal(x.writes(), 1);
  x.store.write = write; assert.equal((await x.store.read()).items[0].status, 'pending');
  await assert.rejects(x.agent.cycle(true), /unresolved/); assert.equal(x.writes(), 1);
});

test('failed durable intent write prevents the request entirely', async t => {
  const x = await setup(t); const draft = await x.agent.cycle(); const write = x.store.write.bind(x.store);
  x.store.write = async s => { if (s.items.some(i => i.status === 'pending')) throw new Error('disk full'); return write(s); };
  await assert.rejects(x.agent.publish(draft.id), /disk full/); assert.equal(x.writes(), 0);
});

test('fresh changed rules, changed thread, different account and suspension all prevent sends', async t => {
  for (const mutation of [
    x => { const old = x.reddit.rules; x.reddit.rules = async n => ({ ...await old(n), description: 'New rule' }); },
    x => { const old = x.reddit.info; x.reddit.info = async n => ({ ...await old(n), selftext: 'Edited' }); },
    x => { x.reddit.me = async () => ({ name: 'another_synthetic_account', id: 'different' }); },
    x => { x.reddit.me = async () => ({ name: 'synthetic_agent', id: 'synthetic-agent', is_suspended: true }); },
    x => { x.reddit.clientId = 'different-app'; }
  ]) {
    const x = await setup(t); const draft = await x.agent.cycle(); mutation(x);
    await assert.rejects(x.agent.publish(draft.id)); assert.equal(x.writes(), 0);
  }
});

test('local stop flag prevents sending and model cannot override destinations', async t => {
  const x = await setup(t);
  x.agent.model = async () => ({ ...(await demoModel()), action: 'comment', community: 'unauthorized', parent: 't3_other', text: 'This is a constructive and sufficiently detailed response about revising a fictional scene.' });
  const draft = await x.agent.cycle(); assert.equal(draft.community, 'writing_lab'); assert.equal(draft.parent, 't3_demo1');
  await writeFile(resolve(x.store.dir, 'STOP'), 'stop');
  await assert.rejects(x.agent.publish(draft.id), /STOP/); assert.equal(x.writes(), 0);
});

test('one process lock excludes concurrent writers', async t => {
  const x = await setup(t);
  await x.store.lock(async () => assert.rejects(new Store(x.root).lock(async () => {}), /lock exists/));
});

test('429 persists cooldown; 403 persists halt; no mutation retries', async t => {
  const x = await setup(t); const until = Date.now() + 600000;
  await x.agent.fail(new RequestError('limited', { status: 429, retryAt: until }));
  assert.equal((await x.store.read()).blockedUntil, until);
  await x.agent.fail(new RequestError('restricted', { status: 403, restriction: true }));
  await assert.rejects(x.agent.ready(), /restriction/);
  let attempts = 0;
  await assert.rejects(requestJson('https://example.invalid', { method: 'POST', write: true }, async () => { attempts++; return new Response('', { status: 503 }); }), e => e.ambiguous);
  assert.equal(attempts, 1);
  assert.equal(retryTime(new Headers({ 'retry-after': '30' }), 1000), 31000);
});

test('malformed success is uncertain and errors never expose raw body', async () => {
  await assert.rejects(requestJson('https://example.invalid', { write: true }, async () => new Response('secret-token-is-here')), e => e.ambiguous && !e.message.includes('secret'));
});

test('Reddit submission requires object ID and handles JSON errors', async t => {
  const x = await setup(t); const c = structuredClone(x.config); Object.keys(c.permissions).forEach(k => c.permissions[k] = true);
  const r = new Reddit(c, x.store, { env: { REDDIT_CLIENT_ID: 'fake', REDDIT_USER_AGENT: 'test' } });
  r.api = async () => ({ json: { data: {} } });
  await assert.rejects(r.submit({ kind: 'post', community: 'writing_lab', title: 'A title', text: 'A story' }), e => e.ambiguous);
});

test('local-first config, explicit consent, strict booleans, no bad model actions', () => {
  validateConfig(base); assert.throws(() => requireConsent(base), /disabled/);
  assert.throws(() => validateConfig({ ...base, ollama: { ...base.ollama, baseUrl: 'http://remote.invalid' } }), /remote/);
  const altered = structuredClone(base); altered.permissions.apiApproved = 'true'; assert.throws(() => validateConfig(altered), /boolean/);
  assert.throws(() => validateProposal({ action: 'vote', text: 'Anything' }, 'comment', base), /invalid action/);
  assert.throws(() => validateProposal({ action: 'comment', text: 'Please visit https://example.com for a special offer.' }, 'comment', base), /link/);
});

test('normalized and near duplicates, persisted budget and clock rollback', () => {
  const a = fingerprint('The moon fell into the silent library and nobody remembered who had left the window open.');
  const b = fingerprint('THE MOON fell into the silent library and nobody remembered who had left the window open!');
  assert.ok(duplicate(a, b)); assert.ok(duplicate(a, fingerprint('The moon fell into the silent library and nobody remembered who had left the window open. Another detail appeared.')));
  assert.throws(() => checkClock({ lastClock: 2000 }, 1000), /backwards/);
  assert.throws(() => checkBudget({ blockedUntil: 0, items: [{ attemptedAt: 1000, status: 'abandoned' }] }, { limits: { maxWritesPerDay: 1 } }, 2000), /budget/);
});

test('OAuth state validation rejects missing, altered and different-length state', () => {
  assert.equal(validState(null, 'secure-state'), false); assert.equal(validState('secure-state', 'secure-state'), true);
  assert.equal(validState('secure-statf', 'secure-state'), false); assert.equal(validState('x', 'secure-state'), false);
});


test('sensitive editorial responses remain drafts in automatic mode; explicit review can publish', async t => {
  const x = await setup(t);
  x.agent.model = async () => { const p = await demoModel(); p.editorial.sensitive = true; return p; };
  const item = await x.agent.cycle(true);
  assert.equal(item.status, 'draft'); assert.equal(item.reviewRequired, true); assert.equal(x.writes(), 0);
  await x.agent.publish(item.id); assert.equal(x.writes(), 1);
});

test('changed editorial digest blocks an existing draft before submission', async t => {
  const x = await setup(t); const draft = await x.agent.cycle();
  const state = await x.store.read(); state.items[0].editorialDigest = 'old'; await x.store.write(state);
  await assert.rejects(x.agent.publish(draft.id), /Editorial guide/); assert.equal(x.writes(), 0);
});
