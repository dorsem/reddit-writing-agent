import { selectLore } from './lore.js';
import { usesEditorial, editorialDigest, checkEditorialItem } from './editorial.js';
import { randomUUID } from 'node:crypto';
import { checkAccount, checkCommunity, checkParent, checkClock, checkBudget, rulesHash, configHash, fingerprint, duplicate, validateProposal, hash } from './policy.js';
import { generate } from './model.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bytesHash, readManuscript, readImage, validateImported } from './intake.js';
import { selectSources } from './research.js';
import { objectHash, checkReplyObject } from './policy.js';

const reservesContent = item => item.status !== 'discarded' || Number.isFinite(item.attemptedAt);

export class Agent {
  constructor(config, store, reddit, model = generate) { this.config = config; this.store = store; this.reddit = reddit; this.model = model; }
  async ready() {
    if (await this.store.stopped()) throw new Error('Local STOP flag is set. Review status before resume --ack.');
    const state = await this.store.read();
    if (state.items.some(x => ['pending', 'unknown'].includes(x.status))) {
      state.halted = 'An unresolved send exists. Reconcile it before continuing.'; await this.store.write(state);
    }
    if (state.halted) throw new Error(state.halted);
    checkClock(state, Date.now());
    const me = await this.reddit.me();
    state.binding = checkAccount(me, state, this.reddit.clientId);
    await this.store.write(state);
    return { state, me };
  }
  target(name, me) {
    if (name === '@profile') return { name: `u_${me.name}`, automationAllowed: this.config.profilePosts === true, profile: true };
    const target = this.config.communities.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!target) throw new Error('Target is not in the local allowlist.');
    return target;
  }
  async targetRules(name, me, state, requireAccepted = true) {
    const target = this.target(name, me);
    const rules = await this.reddit.rules(target.name);
    checkCommunity(rules, target, me);
    const digest = rulesHash(rules);
    if (requireAccepted && state.rules[name.toLowerCase()]?.digest !== digest) throw new Error('Community rules are new or changed. Read and accept them with rules TARGET --accept.');
    return { target, rules, digest };
  }
  async acceptRules(name, accept = false) {
    const { state, me } = await this.ready();
    const result = await this.targetRules(name, me, state, false);
    if (accept) { state.rules[name.toLowerCase()] = { digest: result.digest, acceptedAt: Date.now() }; await this.store.write(state); }
    return { name: result.target.name, digest: result.digest, rules: result.rules.rules, description: result.rules.description,
      publicDescription: result.rules.publicDescription, submitText: result.rules.submitText, accepted: accept };
  }
  async cycle(publish = false, webSources = []) {
    const { state, me } = await this.ready();
    if (publish) checkBudget(state, this.config, Date.now());
    if (state.items.filter(x => x.status === 'draft').length >= this.config.limits.maxDrafts) throw new Error('Draft queue is full. Review or reject queued drafts.');
    const targets = this.config.communities.map(x => x.name);
    if (this.config.profilePosts === true) targets.push('@profile');
    if (!targets.length) throw new Error('Configure a community allowlist or profilePosts first.');
    const cursor = state.cursor || 0; state.cursor = cursor + 1; await this.store.write(state);
    const name = targets[cursor % targets.length];
    const { target, rules, digest } = await this.targetRules(name, me, state);
    const makePost = target.profile || (this.config.actions.posts && (!this.config.actions.comments || Math.floor(cursor / targets.length) % 2 === 1));
    const kind = makePost ? 'post' : 'comment';
    if ((kind === 'post' && !this.config.actions.posts) || (kind === 'comment' && !this.config.actions.comments)) return { skipped: 'This action is disabled.' };
    if (kind === 'post' && rules.submissionType === 'link') throw new Error('Community does not accept text posts.');
    let parent, context;
    if (kind === 'comment') {
      const posts = await this.reddit.recent(target.name);
      parent = posts.find(p => {
        if (state.seen.includes(p.name) || state.items.some(x => x.parent === p.name)) return false;
        try { checkParent(p, { parent: p.name, community: target.name }, me); return true; } catch { return false; }
      });
      if (!parent) return { skipped: 'No eligible recent discussion.' };
      context = { title: parent.title, text: (parent.selftext || '').slice(0, 8000), comments: await this.reddit.context(parent) };
    }
    const task = { kind, lore: selectLore(this.config, cursor, kind), community: target.name, rules: rules.rules, description: rules.description.slice(0, 10000),
      publicDescription: rules.publicDescription, submitText: rules.submitText,
      topic: this.config.topics[Math.floor(cursor / targets.length) % this.config.topics.length], ...(context ? { thread: context } : {}), sources: webSources };
    const proposal = validateProposal(await this.model(this.config, task), kind, this.config, task.lore, webSources);
    if (parent) state.seen = [...state.seen, parent.name].slice(-2000);
    if (!proposal) { await this.store.write(state); return { skipped: 'Model declined this topic.' }; }
    const contentFingerprint = fingerprint(proposal.body);
    if (state.items.some(x => duplicate(contentFingerprint, x.fingerprint))) { await this.store.write(state); return { skipped: 'Exact or near duplicate.' }; }
    const item = { id: randomUUID(), kind, target: name, community: target.name, parent: parent?.name || null, root: parent?.name || null,
      parentHash: parent ? hash({ title: parent.title, body: parent.selftext || '' }) : null,
      title: proposal.title, text: proposal.text, fingerprint: contentFingerprint, rulesDigest: digest, configDigest: configHash(this.config),
      loreId: proposal.loreId, sourceIds: proposal.sourceIds, reviewRequired: proposal.reviewRequired || this.config.safety?.reviewAll === true, editorial: proposal.assessment,
      ...(usesEditorial(this.config) ? { editorialDigest: editorialDigest() } : {}),
      webSources, sourcesDigest: hash(webSources),
      status: 'draft', createdAt: Date.now() };
    state.items.push(item); await this.store.write(state);
    return publish && !item.reviewRequired ? this.publish(item.id) : item;
  }
  async queue(state, item) {
    if (state.items.filter(x => x.status === 'draft').length >= this.config.limits.maxDrafts) throw new Error('Draft queue is full.');
    if (state.items.some(x => reservesContent(x) && (duplicate(item.fingerprint, x.fingerprint) || (item.image && x.image?.sha256 === item.image.sha256)))) throw new Error('Exact or near duplicate.');
    const draft = { ...item, id: randomUUID(), status: 'draft', createdAt: Date.now(), configDigest: configHash(this.config) };
    state.items.push(draft); await this.store.write(state); return draft;
  }
  async importFile(name, path, title, image = false) {
    if (!this.config.actions.posts) throw new Error('Post action is disabled.');
    const { state, me } = await this.ready();
    const { target, rules, digest } = await this.targetRules(name, me, state);
    if (image ? rules.submissionType === 'self' || rules.about?.allow_images === false : rules.submissionType === 'link') throw new Error('Community does not accept this post type.');
    const input = image ? await readImage(path) : await readManuscript(path);
    const content = validateImported(title, image ? this.config.disclosure : input.text, this.config);
    if (image) content.text = this.config.disclosure;
    const item = { kind: 'post', origin: image ? 'image' : 'manuscript', target: name, community: target.name,
      title: content.title, text: content.text, fingerprint: fingerprint(image ? `image ${input.sha256}` : content.body),
      rulesDigest: digest, reviewRequired: true, sourceIds: [], inputHash: input.sha256 };
    if (image) {
      item.image = { sha256: input.sha256, mime: input.mime, extension: input.extension, size: input.bytes.length };
      await this.store.writeJson(`media-${input.sha256}.json`, { base64: input.bytes.toString('base64') });
    }
    return this.queue(state, item);
  }
  async conversation(parent, me) {
    if (!/^t1_[a-z0-9]+$/.test(parent.name) || !/^t3_[a-z0-9]+$/.test(parent.link_id)) throw new Error('Reply requires a comment with a valid root post.');
    const root = await this.reddit.info(parent.link_id);
    if (root.name !== parent.link_id) throw new Error('Conversation root mismatch.');
    checkReplyObject(root, parent.subreddit, me, { root: true });
    checkReplyObject(parent, root.subreddit, me);
    const chain = [parent]; let cursor = parent;
    while (cursor.parent_id !== root.name) {
      if (chain.length >= 8 || !/^t1_[a-z0-9]+$/.test(cursor.parent_id) || chain.some(x => x.name === cursor.parent_id)) throw new Error('Conversation ancestry is invalid or exceeds eight comments.');
      const ancestor = await this.reddit.info(cursor.parent_id);
      if (ancestor.name !== cursor.parent_id || ancestor.link_id !== root.name) throw new Error('Conversation ancestry changed.');
      checkReplyObject(ancestor, root.subreddit, me, { root: true });
      chain.push(ancestor); cursor = ancestor;
    }
    return { root, chain, snapshots: [root, ...chain].map(x => ({ name: x.name, digest: objectHash(x) })) };
  }
  async reply(fullname, webSources = []) {
    if (!this.config.actions.comments) throw new Error('Comment action is disabled.');
    if (!/^t1_[a-z0-9]+$/.test(fullname)) throw new Error('Use a comment fullname such as t1_abc123.');
    const { state, me } = await this.ready();
    if (state.items.some(x => x.parent === fullname && reservesContent(x))) throw new Error('This comment already has a queued or attempted reply.');
    const parent = await this.reddit.info(fullname);
    if (parent.name !== fullname) throw new Error('Reply target mismatch.');
    const name = parent.subreddit;
    const { target, rules, digest } = await this.targetRules(name, me, state);
    const conversation = await this.conversation(parent, me);
    const task = { kind: 'comment', community: target.name, rules: rules.rules, description: rules.description.slice(0, 10000),
      sources: webSources, thread: { title: conversation.root.title, text: (conversation.root.selftext || '').slice(0, 8000),
        conversation: [...conversation.chain].reverse().map(x => ({ name: x.name, speaker: x.author.toLowerCase() === me.name.toLowerCase() ? 'agent' : 'participant', text: (x.body || '').slice(0, 4000) })), replyTo: fullname } };
    const proposal = validateProposal(await this.model(this.config, task), 'comment', this.config, null, webSources);
    if (!proposal) return { skipped: 'Model declined this reply.' };
    return this.queue(state, { kind: 'comment', origin: 'reply', target: name, community: target.name, parent: fullname, root: conversation.root.name,
      ancestry: conversation.snapshots, title: '', text: proposal.text, fingerprint: fingerprint(proposal.body), rulesDigest: digest,
      webSources, sourcesDigest: hash(webSources), sourceIds: proposal.sourceIds, reviewRequired: true, editorial: proposal.assessment,
      ...(usesEditorial(this.config) ? { editorialDigest: editorialDigest() } : {}) });
  }
  async followups() {
    const { state, me } = await this.ready();
    const sent = state.items.filter(x => x.status === 'sent' && /^t[13]_[a-z0-9]+$/.test(x.receipt?.name)).slice(-20).reverse();
    const candidates = []; const seen = new Set(); const skipped = [];
    for (const item of sent) {
      const root = item.kind === 'post' ? item.receipt.name : (item.root || item.parent);
      if (!/^t3_[a-z0-9]+$/.test(root)) continue;
      // Followups only inspects already-allowed targets; it never enables a new one.
      try { this.target(item.target, me); } catch { continue; }
      for (const comment of await this.reddit.replies(item.receipt.name, root)) {
        if (seen.has(comment.name) || state.items.some(x => x.parent === comment.name && reservesContent(x))) continue;
        try { checkReplyObject(comment, item.community, me); }
        catch { skipped.push(comment.name); continue; }
        seen.add(comment.name);
        candidates.push({ name: comment.name, root, community: item.community, text: (comment.body || '').slice(0, 2000),
          url: `https://www.reddit.com/comments/${root.slice(3)}/_/${comment.name.slice(3)}/` });
      }
    }
    return { candidates, scanned: sent.length, skipped: skipped.length, note: 'Bounded scan: last 20 sent items, up to 25 direct replies each. Not exhaustive; nothing queued or published. Use reply COMMENT_ID.' };
  }
  async publish(id) {
    let { state, me } = await this.ready();
    const item = state.items.find(x => x.id === id);
    if (!item || item.status !== 'draft') throw new Error('Only an unsent draft can be published.');
    if (Date.now() - item.createdAt > 86400000) throw new Error('Draft expired after 24 hours. Reject it and prepare fresh content.');
    checkEditorialItem(item, this.config);
    if (item.webSources?.length) {
      selectSources({ sources: item.webSources }, item.webSources.map(x => x.id));
      if (item.sourcesDigest !== hash(item.webSources)) throw new Error('Research snapshot changed. Prepare a fresh draft.');
    }
    if (item.configDigest !== configHash(this.config)) throw new Error('Configuration changed since generation. Prepare a fresh draft.');
    if (state.items.some(x => x.id !== item.id && Number.isFinite(x.attemptedAt) && duplicate(item.fingerprint, x.fingerprint))) throw new Error('Previously attempted duplicate.');
    const { target, rules, digest } = await this.targetRules(item.target, me, state);
    if (digest !== item.rulesDigest || target.name.toLowerCase() !== item.community.toLowerCase()) throw new Error('Draft rules or target changed.');
    if (item.kind === 'post' && (item.image ? rules.submissionType === 'self' || rules.about?.allow_images === false : rules.submissionType === 'link')) throw new Error('Community does not accept this post type.');
    if (item.kind === 'comment') {
      const post = await this.reddit.info(item.parent);
      if (item.origin === 'reply') {
        const current = await this.conversation(post, me);
        if (post.name !== item.parent || current.root.name !== item.root || hash(current.snapshots) !== hash(item.ancestry)) throw new Error('Conversation changed. Prepare a fresh reply.');
      } else {
        checkParent(post, item, me);
        if (objectHash(post) !== item.parentHash) throw new Error('Parent post changed. Prepare a fresh reply.');
      }
    }
    let imageBytes;
    if (item.image) {
      if (!/^[a-f0-9]{64}$/.test(item.image.sha256)) throw new Error('Invalid image snapshot.');
      const media = JSON.parse(await readFile(resolve(this.store.dir, `media-${item.image.sha256}.json`), 'utf8'));
      imageBytes = Buffer.from(media.base64, 'base64');
      if (imageBytes.length !== item.image.size || bytesHash(imageBytes) !== item.image.sha256) throw new Error('Image snapshot changed. Prepare a fresh draft.');
    }
    // Refresh identity at the final write boundary, after model latency and all reads.
    checkAccount(await this.reddit.me(), state, this.reddit.clientId);
    const latest = await this.store.read(); state.blockedUntil = Math.max(state.blockedUntil, latest.blockedUntil);
    const now = Date.now(); checkClock(state, now); checkBudget(state, this.config, now);
    if (await this.store.stopped()) throw new Error('Local STOP flag is set.');
    item.status = 'pending'; item.attemptedAt = now;
    if (item.image) item.stage = 'asset';
    await this.store.write(state); // fsync before any mutation request; reserves quota.
    let receipt;
    try {
      if (item.image) {
        item.asset = await this.reddit.upload(item.image, imageBytes, async (stage, asset) => {
          item.stage = stage; item.asset = asset; await this.store.write(state);
        });
        // Uploads can take time. Recheck the publication boundary before submitting.
        const fresh = await this.targetRules(item.target, me, state);
        if (fresh.digest !== item.rulesDigest || await this.store.stopped()) throw new Error('Publication checks changed during image upload.');
        checkAccount(await this.reddit.me(), state, this.reddit.clientId);
        const afterUpload = await this.store.read();
        state.blockedUntil = Math.max(state.blockedUntil, afterUpload.blockedUntil);
        state.lastClock = Math.max(state.lastClock, afterUpload.lastClock);
        checkClock(state, Date.now());
        checkBudget({ ...state, items: state.items.filter(x => x.id !== item.id) }, this.config, Date.now());
      }
      item.stage = 'submit'; await this.store.write(state);
      receipt = await this.reddit.submit(item);
    }
    catch (error) {
      const beforeSubmit = item.image && item.stage !== 'submit';
      item.status = beforeSubmit ? 'rejected' : error.ambiguous || !Number.isFinite(error.status) ? 'unknown' : 'rejected';
      item.failure = error.message;
      state.halted = beforeSubmit ? 'Image preparation stopped before post submission. An uploaded asset may exist; inspect before resuming.' : item.status === 'unknown' ? 'Submission outcome is unknown. Do not retry.' : 'Reddit rejected a submission. Review the restriction before resuming.';
      state.blockedUntil = Math.max(state.blockedUntil, error.retryAt || 0);
      await this.store.write(state); throw error;
    }
    item.status = 'sent'; item.receipt = receipt; item.completedAt = Date.now();
    // Retain hashes and the receipt, not a copy of published content.
    delete item.text; delete item.title;
    await this.store.write(state); // if this fails, persisted pending blocks restart.
    return { id: item.id, status: item.status, receipt };
  }
  async fail(error) {
    const state = await this.store.read();
    if (error.retryAt) state.blockedUntil = Math.max(state.blockedUntil, error.retryAt);
    if (error.restriction) state.halted = 'Reddit access restriction. Review the account/application notice before resuming.';
    await this.store.write(state);
  }
}
