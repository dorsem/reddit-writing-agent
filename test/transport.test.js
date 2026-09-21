import test from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Reddit } from '../src/reddit.js';
import { Store } from '../src/store.js';
import { generate } from '../src/model.js';
import { requestJson } from '../src/http.js';

const exec = promisify(execFile);
const base = JSON.parse(await readFile(new URL('../agent.config.example.json', import.meta.url), 'utf8'));
const response = (data, headers = {}) => new Response(JSON.stringify(data), { headers });
async function fixture(t, fetcher) {
  const root = await mkdtemp(resolve(tmpdir(), 'reddit-agent-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  const c = structuredClone(base); Object.keys(c.permissions).forEach(k => c.permissions[k] = true);
  const store = new Store(root);
  await store.writeJson('oauth.json', { clientId: 'test-app', access_token: 'test-access', refresh_token: 'test-refresh', expires_at: Date.now() + 3600000, scope: 'identity read submit' });
  const reddit = new Reddit(c, store, { env: { REDDIT_CLIENT_ID: 'test-app', REDDIT_USER_AGENT: 'test-agent' }, fetcher });
  return { store, reddit, root, c };
}

test('OAuth refresh, actual API form encoding and comment receipt work together', async t => {
  const calls = [];
  const x = await fixture(t, async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/access_token')) {
      assert.equal(init.body.get('grant_type'), 'refresh_token'); assert.equal(init.body.get('refresh_token'), 'test-refresh');
      return response({ access_token: 'fresh-test-access', expires_in: 3600, scope: 'identity read submit' });
    }
    assert.equal(init.headers.authorization, 'Bearer fresh-test-access');
    if (url.endsWith('/api/v1/me')) return response({ id: 'fixture', name: 'fixture_account' });
    assert.equal(url, 'https://oauth.reddit.com/api/comment');
    assert.equal(init.body.get('thing_id'), 't3_thread'); assert.equal(init.body.get('text'), 'Unicode пример & =');
    return response({ json: { errors: [], data: { things: [{ kind: 't1', data: { name: 't1_reply' } }] } } });
  });
  const token = await x.store.token(); token.expires_at = 0; await x.store.writeJson('oauth.json', token);
  assert.equal((await x.reddit.me()).id, 'fixture');
  assert.equal((await x.reddit.submit({ kind: 'comment', parent: 't3_thread', text: 'Unicode пример & =' })).name, 't1_reply');
  assert.equal(calls.length, 3); assert.equal((await x.store.token()).refresh_token, 'test-refresh');
});

test('JSON API rejection is not treated as a successful write', async t => {
  const x = await fixture(t, async () => response({ json: { errors: [['USER_REQUIRED', 'sensitive raw message', '']] } }));
  await assert.rejects(x.reddit.submit({ kind: 'post', title: 'Title', text: 'Text', community: 'writing_lab' }), e => e.restriction && !e.message.includes('sensitive'));
});

test('successful response with exhausted API budget blocks later reads without losing receipt', async t => {
  let calls = 0;
  const x = await fixture(t, async () => { calls++; return response({ json: { errors: [], data: { name: 't3_saved' } } }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' }); });
  assert.equal((await x.reddit.submit({ kind: 'post', title: 'Title', text: 'Text', community: 'writing_lab' })).name, 't3_saved');
  const stale = await x.store.read(); stale.blockedUntil = 0; await x.store.write(stale);
  await assert.rejects(x.reddit.me(), /cooldown/); assert.equal(calls, 1);
});

test('Ollama receives limited task context and no tools or token fields', async () => {
  const c = structuredClone(base); c.ollama.model = 'installed-local-model';
  const task = { kind: 'post', topic: 'A fictional room', rules: [] };
  const result = await generate(c, task, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const payload = JSON.parse(init.body); assert.equal(payload.stream, false); assert.equal(payload.format, 'json'); assert.equal(payload.tools, undefined);
    assert.deepEqual(JSON.parse(payload.messages[1].content), task);
    assert.equal(payload.messages.some(x => /test-refresh|test-access/.test(x.content)), false);
    return response({ message: { content: JSON.stringify({ action: 'skip' }) } });
  });
  assert.equal(result.action, 'skip');
});

test('network timeouts on write are uncertain; reads are not write intents', async () => {
  const fail = async () => { throw new Error('private upstream error'); };
  await assert.rejects(requestJson('https://example.invalid', { write: true }, fail), e => e.ambiguous && !e.message.includes('private'));
  await assert.rejects(requestJson('https://example.invalid', {}, fail), e => !e.ambiguous);
});

test('downloaded CLI init is repeatable, draft mode defaults and API access fails closed', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'reddit-agent-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const run = (...args) => exec(process.execPath, [cli, ...args], { cwd: root });
  assert.match((await run('init')).stdout, /Created/);
  assert.match((await run('init')).stdout, /Kept existing/);
  const c = JSON.parse(await readFile(resolve(root, 'agent.config.json'), 'utf8')); assert.equal(c.permissions.apiApproved, false);
  await assert.rejects(run('run'), e => /access is disabled/.test(e.stderr));
  await run('halt'); assert.equal(JSON.parse((await run('status')).stdout).stop, true);
  await assert.rejects(run('run', '--publsh'), e => /Unknown command/.test(e.stderr));
});


test('preview CLI calls the local model with editorial guidance without Reddit credentials or a queue', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'reddit-agent-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); calls++;
    assert.equal(req.url, '/api/chat');
    assert.match(input.messages[0].content, /Humor and provocation/);
    assert.equal(JSON.parse(input.messages[1].content).kind, 'post');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({ action: 'post', title: 'Who decides?', text: 'Who should be able to challenge a decision made with this system?', editorial: { relevant: true, strategy: 'grounded_question', humor: 'none', sensitive: false, publicationRisk: 'low', evidenceMode: 'reflection' } }) } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const c = structuredClone(base); c.ollama.model = 'fixture'; c.ollama.baseUrl = `http://127.0.0.1:${server.address().port}`;
  await writeFile(resolve(root, 'agent.config.json'), JSON.stringify(c));
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const result = JSON.parse((await exec(process.execPath, [cli, 'preview'], { cwd: root })).stdout);
  assert.equal(calls, 1); assert.equal(result.title, 'Who decides?'); assert.match(result.note, /Not queued/);
  await assert.rejects(access(resolve(root, '.local')), { code: 'ENOENT' });
});
