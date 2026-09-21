import { selectLore } from './lore.js';
import { usesEditorial, editorialDigest, checkEditorialItem } from './editorial.js';
import { randomUUID } from 'node:crypto';
import { checkAccount, checkCommunity, checkParent, checkClock, checkBudget, rulesHash, configHash, fingerprint, duplicate, validateProposal, hash } from './policy.js';
import { generate } from './model.js';

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
  async cycle(publish = false) {
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
      topic: this.config.topics[Math.floor(cursor / targets.length) % this.config.topics.length], ...(context ? { thread: context } : {}) };
    const proposal = validateProposal(await this.model(this.config, task), kind, this.config, task.lore);
    if (parent) state.seen = [...state.seen, parent.name].slice(-2000);
    if (!proposal) { await this.store.write(state); return { skipped: 'Model declined this topic.' }; }
    const contentFingerprint = fingerprint(proposal.body);
    if (state.items.some(x => duplicate(contentFingerprint, x.fingerprint))) { await this.store.write(state); return { skipped: 'Exact or near duplicate.' }; }
    const item = { id: randomUUID(), kind, target: name, community: target.name, parent: parent?.name || null,
      parentHash: parent ? hash({ title: parent.title, body: parent.selftext || '' }) : null,
      title: proposal.title, text: proposal.text, fingerprint: contentFingerprint, rulesDigest: digest, configDigest: configHash(this.config),
      loreId: proposal.loreId, sourceIds: proposal.sourceIds, reviewRequired: proposal.reviewRequired, editorial: proposal.assessment,
      ...(usesEditorial(this.config) ? { editorialDigest: editorialDigest() } : {}),
      status: 'draft', createdAt: Date.now() };
    state.items.push(item); await this.store.write(state);
    return publish && !item.reviewRequired ? this.publish(item.id) : item;
  }
  async publish(id) {
    let { state, me } = await this.ready();
    const item = state.items.find(x => x.id === id);
    if (!item || item.status !== 'draft') throw new Error('Only an unsent draft can be published.');
    if (Date.now() - item.createdAt > 86400000) throw new Error('Draft expired after 24 hours. Reject it and prepare fresh content.');
    checkEditorialItem(item, this.config);
    if (item.configDigest !== configHash(this.config)) throw new Error('Configuration changed since generation. Prepare a fresh draft.');
    if (state.items.some(x => x.id !== item.id && Number.isFinite(x.attemptedAt) && duplicate(item.fingerprint, x.fingerprint))) throw new Error('Previously attempted duplicate.');
    const { target, rules, digest } = await this.targetRules(item.target, me, state);
    if (digest !== item.rulesDigest || target.name.toLowerCase() !== item.community.toLowerCase()) throw new Error('Draft rules or target changed.');
    if (item.kind === 'post' && rules.submissionType === 'link') throw new Error('Community does not accept text posts.');
    if (item.kind === 'comment') {
      const post = await this.reddit.info(item.parent); checkParent(post, item, me);
      if (hash({ title: post.title, body: post.selftext || '' }) !== item.parentHash) throw new Error('Parent post changed. Prepare a fresh reply.');
    }
    // Refresh identity at the final write boundary, after model latency and all reads.
    checkAccount(await this.reddit.me(), state, this.reddit.clientId);
    const latest = await this.store.read(); state.blockedUntil = Math.max(state.blockedUntil, latest.blockedUntil);
    const now = Date.now(); checkClock(state, now); checkBudget(state, this.config, now);
    if (await this.store.stopped()) throw new Error('Local STOP flag is set.');
    item.status = 'pending'; item.attemptedAt = now;
    await this.store.write(state); // fsync before any mutation request; reserves quota.
    let receipt;
    try { receipt = await this.reddit.submit(item); }
    catch (error) {
      item.status = error.ambiguous || !Number.isFinite(error.status) ? 'unknown' : 'rejected';
      item.failure = error.message;
      state.halted = item.status === 'unknown' ? 'Submission outcome is unknown. Do not retry.' : 'Reddit rejected a submission. Review the restriction before resuming.';
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
