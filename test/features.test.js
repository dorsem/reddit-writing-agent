import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.js';
import { Agent } from '../src/agent.js';
import { Reddit } from '../src/reddit.js';
import { demoReddit, demoModel } from '../src/demo.js';
import { readImage, readManuscript } from '../src/intake.js';
import { research, selectSources } from '../src/research.js';
import { uploadMedia, waitForMedia, matchesImageReceipt } from '../src/media.js';
import { initFleet, loadFleet, runFleet } from '../src/fleet.js';
import { validateProposal } from '../src/policy.js';
import { validateConfig } from '../src/config.js';
import { RequestError } from '../src/http.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const base = JSON.parse(await readFile(new URL('../agent.config.example.json', import.meta.url), 'utf8'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII=', 'base64');
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'reddit-features-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = structuredClone(base); config.communities = [{ name: 'writing_lab', automationAllowed: true }]; config.actions.posts = true;
  const store = new Store(root); const reddit = demoReddit(); let writes = 0;
  reddit.submit = async () => { writes++; return { name: 't3_post' }; };
  const agent = new Agent(config, store, reddit, demoModel);
  await agent.acceptRules('writing_lab', true);
  return { root, config, store, reddit, agent, writes: () => writes };
}

function replyFixture(x) {
  const now = Date.now() / 1000;
  const objects = {
    t3_root: { name: 't3_root', title: 'Original discussion', selftext: 'Root body', subreddit: 'writing_lab', author: 'synthetic_agent', created_utc: now - 86400 * 2 },
    t1_own: { name: 't1_own', body: 'Prior assistant answer', parent_id: 't3_root', link_id: 't3_root', subreddit: 'writing_lab', author: 'synthetic_agent', created_utc: now - 100 },
    t1_incoming: { name: 't1_incoming', body: 'Could you explain this other point?', parent_id: 't1_own', link_id: 't3_root', subreddit: 'writing_lab', author: 'reader', created_utc: now - 10 }
  };
  x.reddit.info = async id => structuredClone(objects[id]);
  return objects;
}

test('reply drafts include ancestry, preserve explicit recipient and require no writes', async t => {
  const x = await fixture(t); replyFixture(x); let task;
  x.agent.model = async (c, input) => { task = input; return { ...await demoModel(c, input), parent: 't1_attacker' }; };
  const draft = await x.agent.reply('t1_incoming');
  assert.equal(draft.parent, 't1_incoming'); assert.equal(draft.root, 't3_root'); assert.equal(draft.reviewRequired, true);
  assert.deepEqual(task.thread.conversation.map(x => x.name), ['t1_own', 't1_incoming']); assert.equal(x.writes(), 0);
  assert.deepEqual(task.thread.conversation.map(x => x.speaker), ['agent', 'participant']);
  assert.equal(JSON.stringify(task).includes('synthetic_agent'), false);
  await assert.rejects(x.agent.reply('t1_incoming'), /already/);
  x.reddit.submit = async item => { assert.equal(item.parent, 't1_incoming'); return { name: 't1_response' }; };
  assert.equal((await x.agent.publish(draft.id)).status, 'sent');
});

test('discarding an unsent reply allows a fresh answer to the edited question', async t => {
  const x = await fixture(t); const objects = replyFixture(x); const first = await x.agent.reply('t1_incoming');
  const state = await x.store.read(); state.items[0].status = 'discarded'; delete state.items[0].text; await x.store.write(state);
  objects.t1_incoming.body = 'An edited question for a new draft';
  const replacement = await x.agent.reply('t1_incoming');
  assert.notEqual(replacement.id, first.id); assert.equal(replacement.status, 'draft'); assert.equal(x.writes(), 0);
});

test('edited, deleted and locked conversation nodes block a queued reply', async t => {
  for (const change of [o => o.t1_incoming.body = 'Edited question', o => o.t1_own.body = '[deleted]', o => o.t3_root.locked = true, o => o.t1_incoming.link_id = 't3_other']) {
    const x = await fixture(t); const objects = replyFixture(x); const draft = await x.agent.reply('t1_incoming'); change(objects);
    await assert.rejects(x.agent.publish(draft.id)); assert.equal(x.writes(), 0);
  }
});

test('self replies, disabled comments and excessive ancestry fail before model use', async t => {
  const x = await fixture(t); const objects = replyFixture(x); let calls = 0;
  x.agent.model = async () => { calls++; return { action: 'skip' }; };
  await assert.rejects(x.agent.reply('t1_own'), /authenticated/);
  objects.t1_own.parent_id = 't1_incoming'; await assert.rejects(x.agent.reply('t1_incoming'), /ancestry/);
  x.config.actions.comments = false; await assert.rejects(x.agent.reply('t1_incoming'), /disabled/); assert.equal(calls, 0);
});

test('followups lists direct external replies once without enqueueing or sending', async t => {
  const x = await fixture(t); const objects = replyFixture(x);
  const state = await x.store.read(); state.items.push({ id: 'old', kind: 'comment', status: 'sent', parent: 't3_root', target: 'writing_lab', community: 'writing_lab', receipt: { name: 't1_own' } }); await x.store.write(state);
  x.reddit.replies = async (id, root) => { assert.equal(id, 't1_own'); assert.equal(root, 't3_root'); return [objects.t1_incoming, objects.t1_own, objects.t1_incoming]; };
  const result = await x.agent.followups(); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].name, 't1_incoming');
  assert.equal((await x.store.read()).items.length, 1); assert.equal(x.writes(), 0);
});

test('manuscript import preserves Unicode, spacing, URLs and line endings without model calls', async t => {
  const x = await fixture(t); const body = '# Рукопись\r\n\r\n  Первый абзац. https://example.org/source\r\n';
  const path = resolve(x.root, 'my manuscript.md'); await writeFile(path, body);
  x.agent.model = async () => { throw new Error('Model must not run'); };
  const draft = await x.agent.importFile('writing_lab', path, 'Мой заголовок');
  assert.equal(draft.text, `${body}\n\n---\n${x.config.disclosure}`); assert.equal(draft.origin, 'manuscript'); assert.equal(x.writes(), 0);
  await writeFile(path, 'Changed file after import'); await x.agent.publish(draft.id); assert.equal(x.writes(), 1);
});

test('imports reject invalid UTF-8, oversized text, wrong extension and disabled posts', async t => {
  const x = await fixture(t); const path = resolve(x.root, 'manuscript.txt');
  await writeFile(path, Buffer.from([0xff, 0xff])); await assert.rejects(readManuscript(path), /UTF-8/);
  await writeFile(path, 'a'.repeat(100001)); await assert.rejects(readManuscript(path), /at most/);
  await writeFile(path, 'a'.repeat(x.config.limits.maxBodyChars)); await assert.rejects(x.agent.importFile('writing_lab', path, 'Title'), /maxBodyChars/);
  await assert.rejects(readManuscript(resolve(x.root, '.env')), /md or .txt/);
  x.config.actions.posts = false; await assert.rejects(x.agent.importFile('writing_lab', path, 'Title'), /disabled/);
});

test('image draft snapshots bytes; asset allocation happens only after durable pending intent', async t => {
  const x = await fixture(t); const path = resolve(x.root, 'image.png'); await writeFile(path, png);
  const draft = await x.agent.importFile('writing_lab', path, 'Image caption', true); assert.equal(x.writes(), 0);
  await writeFile(path, 'Original was replaced');
  x.reddit.upload = async (image, bytes, record) => {
    assert.deepEqual(bytes, png); const stored = (await x.store.read()).items[0]; assert.equal(stored.status, 'pending'); assert.equal(stored.stage, 'asset');
    const asset = { id: 'asset', url: 'https://reddit-uploaded-media.s3-accelerate.amazonaws.com/asset.png' };
    await record('uploaded', asset); return asset;
  };
  x.reddit.submit = async item => { assert.equal((await x.store.read()).items[0].stage, 'submit'); assert.equal(item.asset.id, 'asset'); return { name: 't3_image' }; };
  await x.agent.publish(draft.id); assert.equal((await x.store.read()).items[0].status, 'sent');
});

test('media upload failure is not a post; lost submit response is unresolved and never retried', async t => {
  for (const failUpload of [true, false]) {
    const x = await fixture(t); const path = resolve(x.root, 'image.png'); await writeFile(path, png);
    const draft = await x.agent.importFile('writing_lab', path, 'Image', true); let uploads = 0; let submits = 0;
    x.reddit.upload = async () => { uploads++; if (failUpload) throw new Error('upload failed'); return { id: 'asset', url: 'https://i.redd.it/asset.png' }; };
    x.reddit.submit = async () => { submits++; throw new RequestError('response lost', { ambiguous: true }); };
    await assert.rejects(x.agent.publish(draft.id));
    const saved = (await x.store.read()).items[0]; assert.equal(saved.status, failUpload ? 'rejected' : 'unknown');
    assert.equal(submits, failUpload ? 0 : 1); await assert.rejects(x.agent.publish(draft.id)); assert.equal(uploads, 1);
  }
});

test('tampered snapshot and new STOP during image upload prevent submission', async t => {
  const x = await fixture(t); const path = resolve(x.root, 'image.png'); await writeFile(path, png);
  const draft = await x.agent.importFile('writing_lab', path, 'Image', true);
  const mediaPath = resolve(x.store.dir, `media-${draft.image.sha256}.json`);
  await writeFile(mediaPath, JSON.stringify({ base64: Buffer.from('wrong').toString('base64') }));
  await assert.rejects(x.agent.publish(draft.id), /snapshot changed/); assert.equal(x.writes(), 0);
  await writeFile(mediaPath, JSON.stringify({ base64: png.toString('base64') }));
  x.reddit.upload = async () => { await writeFile(resolve(x.store.dir, 'STOP'), 'stop'); return { id: 'asset', url: 'https://i.redd.it/asset.png' }; };
  await assert.rejects(x.agent.publish(draft.id), /checks changed/); assert.equal(x.writes(), 0);
});

test('a rate limit learned during image upload prevents submission and survives the halt', async t => {
  const x = await fixture(t); const path = resolve(x.root, 'image.png'); await writeFile(path, png);
  const draft = await x.agent.importFile('writing_lab', path, 'Image', true);
  const retryAt = Date.now() + 600000;
  x.reddit.upload = async () => {
    const state = await x.store.read(); state.blockedUntil = retryAt; await x.store.write(state);
    return { id: 'asset', url: 'https://i.redd.it/asset.png' };
  };
  await assert.rejects(x.agent.publish(draft.id), /cooldown/);
  const stored = await x.store.read(); assert.equal(stored.blockedUntil, retryAt); assert.equal(stored.items[0].status, 'rejected'); assert.equal(x.writes(), 0);
});

test('image reconciliation requires the uploaded asset URL, not a matching suffix', () => {
  const item = { asset: { id: 'asset123', url: 'https://reddit-uploaded-media.s3-accelerate.amazonaws.com/asset123.png' }, image: { extension: 'png' } };
  assert.equal(matchesImageReceipt(item, { url: item.asset.url }), true);
  assert.equal(matchesImageReceipt(item, { url: 'https://i.redd.it/asset123.png' }), true);
  for (const url of ['https://example.org/asset123.png', 'https://i.redd.it/wrongasset123.png', 'https://i.redd.it/asset123.png?x=1', 'https://i.redd.it/asset123.jpg']) assert.equal(matchesImageReceipt(item, { url }), false);
});

test('upload lease uses narrow host and multipart image without Reddit authorization header', async t => {
  const x = await fixture(t); const path = resolve(x.root, 'image.png'); await writeFile(path, png); const image = await readImage(path);
  const stages = [];
  const reddit = { api: async (path, form) => {
    assert.equal(path, '/api/media/asset.json'); assert.equal(form.mimetype, 'image/png');
    return { args: { action: '//reddit-uploaded-media.s3-accelerate.amazonaws.com', fields: [{ name: 'key', value: 'asset.png' }, { name: 'policy', value: 'signed' }] }, asset: { asset_id: 'asset' } };
  } };
  const asset = await uploadMedia(reddit, image, png, async stage => stages.push(stage), async (url, init) => {
    assert.equal(url, 'https://reddit-uploaded-media.s3-accelerate.amazonaws.com/'); assert.equal(init.headers, undefined); assert.equal(init.redirect, 'error');
    assert.equal(init.body.get('key'), 'asset.png'); assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), png);
    return new Response(null, { status: 204 });
  });
  assert.equal(asset.id, 'asset'); assert.deepEqual(stages, ['uploading', 'uploaded']);
  reddit.api = async () => ({ args: { action: 'https://attacker.example/', fields: [] }, asset: { asset_id: 'x' } });
  await assert.rejects(uploadMedia(reddit, image, png, () => {}, () => { throw new Error('Must not fetch'); }), /destination/);
});

test('image confirmation validates destination, handles success and treats socket loss as uncertain', async () => {
  const factory = payload => () => {
    const socket = new EventTarget(); socket.close = () => {};
    queueMicrotask(() => { const event = new Event('message'); event.data = JSON.stringify(payload); socket.dispatchEvent(event); });
    return socket;
  };
  const receipt = await waitForMedia('wss://events.redditmedia.com/socket', factory({ payload: { redirect: 'https://www.reddit.com/r/lab/comments/abc123/title/' } }));
  assert.equal(receipt.name, 't3_abc123');
  await assert.rejects(waitForMedia('wss://attacker.example/socket', factory({})), e => e.ambiguous);
  await assert.rejects(waitForMedia('wss://events.redditmedia.com/socket', factory({ payload: { redirect: 'https://attacker.example/comments/fake/' } })), e => e.ambiguous);
  await assert.rejects(waitForMedia('wss://events.redditmedia.com/socket', () => { const socket = new EventTarget(); socket.close = () => {}; return socket; }, 10), e => e.ambiguous);
});

test('image submission sends the uploaded asset and waits for a Reddit post receipt', async t => {
  const x = await fixture(t); const config = structuredClone(x.config); for (const key in config.permissions) config.permissions[key] = true;
  const reddit = new Reddit(config, x.store, { env: { REDDIT_CLIENT_ID: 'test', REDDIT_USER_AGENT: 'test' }, socketFactory: url => {
    assert.equal(url, 'wss://events.redditmedia.com/socket');
    const socket = new EventTarget(); socket.close = () => {};
    queueMicrotask(() => { const event = new Event('message'); event.data = JSON.stringify({ payload: { redirect: 'https://www.reddit.com/comments/image123/' } }); socket.dispatchEvent(event); });
    return socket;
  } });
  reddit.api = async (path, params) => {
    assert.equal(path, '/api/submit');
    assert.equal(params.kind, 'image'); assert.equal(params.url, 'https://i.redd.it/asset.png');
    assert.equal(params.text, config.disclosure); assert.equal(params.title, 'Image post'); assert.equal(params.sr, 'writing_lab');
    return { json: { data: { websocket_url: 'wss://events.redditmedia.com/socket' } } };
  };
  const receipt = await reddit.submit({ kind: 'post', community: 'writing_lab', title: 'Image post', text: config.disclosure, image: {}, asset: { url: 'https://i.redd.it/asset.png' } });
  assert.deepEqual(receipt, { name: 't3_image123', url: 'https://www.reddit.com/comments/image123/' });
});

test('community discovery and direct-reply transport are read-only and correctly filter listings', async t => {
  const x = await fixture(t); const config = structuredClone(x.config); for (const key in config.permissions) config.permissions[key] = true;
  const reddit = new Reddit(config, x.store, { env: { REDDIT_CLIENT_ID: 'test', REDDIT_USER_AGENT: 'test' } });
  reddit.api = async (path, params) => {
    assert.equal(params, undefined); assert.match(path, /^\/subreddits\/search\?/); assert.equal(new URL(`https://reddit.com${path}`).searchParams.get('q'), 'ecology & AI');
    return { data: { children: [{ kind: 't5', data: { display_name: 'ecology', title: 'Ecology', public_description: 'Research' } }, { kind: 't5', data: { display_name: 'adult', over18: true } }] } };
  };
  assert.deepEqual((await reddit.discover('ecology & AI')).map(x => x.name), ['ecology']); assert.equal(config.communities.length, 1);
  reddit.api = async path => { assert.match(path, /\/comments\/root\.json/); return [{}, { data: { children: [{ kind: 't1', data: { name: 't1_own', parent_id: 't3_root', replies: { data: { children: [{ kind: 't1', data: { name: 't1_child', parent_id: 't1_own' } }] } } } }] } }]; };
  assert.equal((await reddit.replies('t1_own', 't3_root'))[0].name, 't1_child');
  reddit.api = async (path, params) => { assert.equal(path, '/api/comment'); assert.equal(params.thing_id, 't1_child'); return { json: { data: { things: [{ data: { name: 't1_new' } }] } } }; };
  assert.equal((await reddit.submit({ kind: 'comment', parent: 't1_child', root: 't3_root', text: 'A reply' })).url, 'https://www.reddit.com/comments/root/_/new/');
});

test('research keeps provenance, deduplicates URLs and rejects unselected or expired citations', async () => {
  const config = { ...base, research: { provider: 'searxng', baseUrl: 'http://127.0.0.1:8080', maxResults: 5 } };
  const packet = await research(config, 'habitat restoration', async (url, init) => {
    assert.equal(new URL(url).searchParams.get('q'), 'habitat restoration'); assert.equal(init.headers?.authorization, undefined);
    return json({ results: [{ title: 'Research [paper]', url: 'https://example.org/paper', content: '<b>Excerpt</b>' }, { title: 'Duplicate', url: 'https://example.org/paper', content: 'Duplicate' }, { title: 'Private', url: 'http://127.0.0.1/internal', content: 'bad' }] });
  });
  assert.equal(packet.sources.length, 1); assert.equal(packet.sources[0].excerpt, 'Excerpt'); assert.equal(packet.sources[0].evidence, 'unverified-search-excerpt');
  const selected = selectSources(packet, [packet.sources[0].id]);
  const proposal = { action: 'comment', text: `A source to inspect for this claim is [[${selected[0].id}]].`, editorial: { relevant: true, strategy: 'definition', humor: 'none', sensitive: false, publicationRisk: 'low', evidenceMode: 'sourced' } };
  const rendered = validateProposal(proposal, 'comment', base, null, selected);
  assert.equal(rendered.reviewRequired, true); assert.match(rendered.text, /https:\/\/example.org\/paper/);
  assert.throws(() => validateProposal(proposal, 'comment', base), /Unknown/);
  assert.throws(() => selectSources(packet, [selected[0].id], Date.now() + 86401000), /older/);
  assert.throws(() => validateConfig({ ...base, research: { ...config.research, baseUrl: 'http://remote.example' } }), /HTTPS/);
});

test('Wikipedia search identifies its scope and does not fetch result pages', async () => {
  let calls = 0;
  const result = await research(base, 'Floods', async url => { calls++; assert.equal(new URL(url).hostname, 'en.wikipedia.org'); return json({ query: { search: [{ title: 'Flood', snippet: 'Flood overview' }] } }); });
  assert.equal(calls, 1); assert.equal(result.provider, 'wikipedia'); assert.match(result.note, /Pages were not fetched/);
});

test('selected research reaches generation, forces review and expires before publication', async t => {
  const x = await fixture(t);
  const packet = await research(base, 'Floods', async () => json({ query: { search: [{ title: 'Flood', snippet: 'Flood overview' }] } }));
  const sources = selectSources(packet, [packet.sources[0].id]);
  x.agent.model = async (config, task) => { assert.deepEqual(task.sources, sources); return demoModel(config, task); };
  const draft = await x.agent.cycle(true, sources);
  assert.equal(draft.status, 'draft'); assert.equal(draft.reviewRequired, true); assert.equal(x.writes(), 0);
  const state = await x.store.read(); state.items[0].webSources[0].retrievedAt -= 86401000; await x.store.write(state);
  await assert.rejects(x.agent.publish(draft.id), /older than 24 hours/); assert.equal(x.writes(), 0);
});

async function fleetFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'reddit-fleet-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await initFleet(root, packageRoot);
  for (const [index, entry] of manifest.agents.entries()) {
    const store = new Store(resolve(root, entry.directory)); const state = await store.read(); state.binding = { id: `owner-${index}`, clientId: `app-${index}` }; await store.write(state);
  }
  return { root, manifest };
}

test('fleet creates isolated configs without overwriting and rejects duplicate accounts/directories', async t => {
  const x = await fleetFixture(t); assert.equal((await loadFleet(x.root)).length, 2);
  await assert.rejects(initFleet(x.root, packageRoot), { code: 'EEXIST' });
  const secondStore = new Store(resolve(x.root, x.manifest.agents[1].directory)); const state = await secondStore.read(); state.binding.id = 'owner-0'; await secondStore.write(state);
  await assert.rejects(loadFleet(x.root), /only once/);
  await symlink(resolve(x.root, x.manifest.agents[0].directory), resolve(x.root, 'alias'), 'junction');
  x.manifest.agents[1].directory = 'alias'; await writeFile(resolve(x.root, 'fleet.config.json'), JSON.stringify(x.manifest));
  await assert.rejects(loadFleet(x.root), /share a directory/);
});

test('fleet workers run concurrently in separate directories, do not inherit Reddit credentials and isolate failures', async t => {
  const x = await fleetFixture(t); const calls = []; const children = [];
  const old = process.env.REDDIT_CLIENT_SECRET; process.env.REDDIT_CLIENT_SECRET = 'do-not-inherit';
  t.after(() => { if (old === undefined) delete process.env.REDDIT_CLIENT_SECRET; else process.env.REDDIT_CLIENT_SECRET = old; });
  const result = await runFleet(x.root, '/agent/cli.js', { cycles: 2, spawnProcess: (node, args, options) => {
    calls.push({ node, args, options }); const child = new EventEmitter(); child.stdout = child.stderr = undefined; child.kill = () => {}; children.push(child);
    if (children.length === 2) queueMicrotask(() => { children[0].emit('close', 1); children[1].emit('close', 0); });
    return child;
  } });
  assert.equal(calls.length, 2); assert.notEqual(calls[0].options.cwd, calls[1].options.cwd);
  for (const call of calls) { assert.equal(call.options.env.REDDIT_CLIENT_SECRET, undefined); assert.deepEqual(call.args, ['/agent/cli.js', 'run', '--cycles', '2']); }
  assert.equal(result.success, false); assert.deepEqual(result.results.map(x => x.code), [1, 0]);
});

test('fleet interruption signals every worker and reports cancellation', async t => {
  const x = await fleetFixture(t); const controller = new AbortController(); const killed = [];
  let count = 0;
  const result = await runFleet(x.root, '/cli.js', { signal: controller.signal, spawnProcess: () => {
    const child = new EventEmitter(); child.kill = signal => { killed.push(signal); queueMicrotask(() => child.emit('close', null)); };
    if (++count === 2) queueMicrotask(() => controller.abort()); return child;
  } });
  assert.deepEqual(killed, ['SIGINT', 'SIGINT']); assert.equal(result.interrupted, true); assert.equal(result.success, false);
});

test('real fleet child processes load each account environment independently', async t => {
  const x = await fleetFixture(t);
  for (const [index, entry] of x.manifest.agents.entries()) await writeFile(resolve(x.root, entry.directory, '.env'), `REDDIT_CLIENT_ID=fixture-account-${index}\n`);
  const cli = resolve(x.root, 'worker.mjs');
  await writeFile(cli, `import { loadConfig } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};\nawait loadConfig(process.cwd());\nconsole.log(JSON.stringify({ client: process.env.REDDIT_CLIENT_ID, args: process.argv.slice(2) }));\n`);
  const lines = [];
  const result = await runFleet(x.root, cli, { cycles: 2, output: line => lines.push(line) });
  assert.equal(result.success, true);
  assert.equal(lines.length, 2);
  for (const [index, entry] of x.manifest.agents.entries()) {
    const prefix = `[${entry.name}] `; const line = lines.find(x => x.startsWith(prefix));
    assert.deepEqual(JSON.parse(line.slice(prefix.length)), { client: `fixture-account-${index}`, args: ['run', '--cycles', '2'] });
  }
});

test('CLI fleet setup works without a root config and rejects unconnected accounts and malformed flags', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'reddit-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = resolve(packageRoot, 'bin/cli.js');
  const run = args => promisify(execFile)(process.execPath, [cli, ...args], { cwd: root, timeout: 10000 });
  await run(['fleet', 'init']);
  const status = JSON.parse((await run(['fleet', 'status'])).stdout);
  assert.equal(status.length, 2); assert.ok(status.every(x => !x.connected));
  await assert.rejects(run(['fleet', 'run']), /Connect agent-one/);
  await assert.rejects(run(['fleet', 'run', '--cycles', '0']), /cycles must/);
  await assert.rejects(run(['fleet', 'status', '--publish']), /Use fleet/);
  await assert.rejects(run(['run', '--sources']), /Missing value/);
  await assert.rejects(run(['image', 'writing_lab', 'image with spaces.png']), /Use --title/);
});
