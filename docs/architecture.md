# Architecture

Node.js 22+ ESM, built-in modules only. There is no hosted service, telemetry, browser controller, password login, account rotation or remote scheduler.

```
local configuration → OAuth identity → allowed target + live rules
   → fresh discussion/topic → Ollama proposal → deterministic validation
   → local draft → fresh checks → durable pending intent → Reddit API
                                                 ↘ uncertain → halt
```

The model can propose `skip`, `post` or `comment` text. It cannot pick an API endpoint, author, destination or credentials. Community and thread content are quoted as untrusted data. This limits model authority; it does not guarantee resistance to malicious prompts or factual correctness.

Modules:

| Module | Responsibility |
| --- | --- |
| `config.js` | Typed local settings, explicit access declarations, local model default |
| `reddit.js` | Code-flow OAuth, token refresh, narrow API methods, receipt extraction |
| `http.js` | Request deadlines, no redirect following, rate-limit parsing, sanitized errors |
| `model.js` | Ollama JSON generation with no tools or credentials in context |
| `policy.js` | Identity, community, parent, age, rule version, budget and duplicate checks |
| `store.js` | Atomic JSON replacement, file sync, exclusive process lock, private file modes |
| `agent.js` | Generation and single-write outbox orchestration |
| `bin/cli.js` | Explicit operator commands and finite runs |

## Write states

`draft → pending → sent`. A definite rejection becomes `rejected` with a local halt. Network ambiguity becomes `unknown`. A process crash can leave `pending`; startup treats it as unresolved and stops. Only explicit reconciliation can move pending/unknown to sent or abandoned. Neither rejected nor abandoned records are requeued automatically. All attempts retain a fingerprint and consume the rolling budget.

A draft contains a digest of its configuration, rules and parent text. Before sending, the app rechecks the live identity, target, rules, parent, age, STOP flag and budget. It commits `pending` with `attemptedAt` before submitting. One invocation holds a filesystem lock across checks and the write. The lock is released between cycles. Disk failure before pending persistence prevents the request; disk failure after server acceptance leaves pending for reconciliation.

This is an **at-most-one-attempt workflow within one intact local state directory**, not an exactly-once delivery protocol. Reddit does not provide a transaction spanning its service and this journal. Deleting state, running another installation, changing system files or a compromised machine breaks those assumptions. Wall-clock rollback is detected; malicious forward clock changes are outside the threat model.

Rules acceptance records the operator's judgment. Account eligibility and API approval are declarations; the code cannot verify every private notice or contractual permission. The content similarity filter uses normalized text and hashed three-word shingles. It catches many near copies but is not a semantic moderation classifier.

## Validation

`npm test` runs offline tests with isolated temporary state and fake API boundaries. They cover uncertainty, restart, failures before/after intent persistence, identity and app mismatch, changed rules and parent, rate limits, local stops, lock exclusion, deduplication and OAuth state checks. `npm run demo` exercises the draft pipeline with synthetic content. Real Reddit and live model validation require an approved app and locally configured model and are not claimed by these tests.

## Editorial profile

`editorial/commons.md` supplies the thematic voice and response strategies. `editorial/sources.json` supplies manually reviewed, dated evidence notes. The model selects a strategy and labels sensitivity and evidence use. `src/editorial.js` validates that metadata and resolves only known, unexpired citation markers; it cannot verify whether prose is true, relevant, or actually supported by a citation. Sensitive drafts bypass automatic publication and require the explicit `publish ID` path.

Drafts retain a digest of the guide and source packet. Publication checks that digest and source expiry. Files are loaded when the process starts; restart after editing them. `preview` calls only the configured model and validates a sample post without constructing a Reddit client or creating a journal.

`editorial/lore.json` contains optional fictional motifs. The scheduler offers at most one motif on configured cycle boundaries, only for posts. A model may omit it. Known raw motifs and invalid markers are rejected; this does not detect every paraphrase or inappropriate use. The packet is included in the editorial digest. Philosophy is prompt guidance, not a factual-verification layer. All built-in behavior is documented and can be disabled by the operator.

## Extended workflows (0.2)

All preparation commands are read-only with respect to Reddit. `reply` retains separate immediate-comment and root-submission fullnames plus hashes of up to eight ancestor comments. Publication refetches the chain. `followups` examines direct replies to at most 20 local receipts, without inbox scopes or automatic enrollment. `discover` never changes the allowlist.

`import` reads bounded UTF-8 Markdown/text and queues the exact body plus disclosure without invoking the model. `image` validates PNG/JPEG signatures, saves a private byte snapshot and hashes it. At publication, the application persists `pending`, obtains a media lease, uploads only to the Reddit media S3 bucket, records the asset, then persists the `submit` stage before the post request. The S3 request carries lease fields, never Reddit authorization. WebSocket confirmation is limited to `redditmedia.com`; failure after submit remains ambiguous. Failure before submit may leave an orphan asset, not an unknown published post. Native image upload uses Reddit's undocumented media endpoint, following PRAW.

`research` calls only the explicitly configured Wikipedia or SearXNG provider. Selected result IDs become bounded, timestamped snapshots inside the draft. They are unverified search excerpts, separate from the bundled editorial evidence. The model cannot supply citation URLs; rendering resolves chosen IDs. Source snapshots expire after 24 hours and always require explicit publication review. No result page is fetched.

`fleet` is a bounded local process supervisor (1–8 workers). Each worker has a separate working directory and ordinary Store lock. Preflight rejects repeated canonical directories and repeated bound Reddit account IDs. Workers do not inherit `REDDIT_*` variables, and each reads its own `.env`. A worker failure is reported independently; no task or credential migration occurs. SIGINT/SIGTERM is forwarded to active workers. Independent processes may share an Ollama server, which controls inference concurrency.

Protocol references: [Reddit API](https://www.reddit.com/dev/api/), [PRAW media upload](https://github.com/praw-dev/praw/blob/main/praw/models/media.py), [PRAW media submission](https://github.com/praw-dev/praw/blob/main/praw/models/reddit/subreddit/subreddit.py), [MediaWiki search](https://www.mediawiki.org/wiki/API:Search), [SearXNG search](https://docs.searxng.org/dev/search_api.html).
