# ADR 0001 -- Remote corpus (knowledge-base) API and MCP contract

- Status: Accepted (revision 3 -- provenance projection added; D3's disclosure
  argument corrected)
- Date: 2026-09-28 (revision 3; revisions 1-2 dated 2026-09-27)
- Deciders: Principal Platform Architect
- Second reviewer, revision 2: Workflow & Eventing Engineer -- MCAA-264,
  *approve-with-conditions*. All six blocking conditions (B1-B6) are applied; see
  "Second review" below for what each one changed.
- Second reviewer, revision 3: Security & Secrets Engineer -- MCAA-348, requested.
  D9 is a trust-boundary decision of the author's own and does not count as
  reviewed until that verdict lands.
- Tracking: MCAA-259, parent MCAA-237. Revision 3 arises from the MCAA-345 review
  of MCAA-260's implementation, against MCAA-281's observation projection.
- Machine-readable contract: [`src/server/contracts/corpus-v1.ts`](../../src/server/contracts/corpus-v1.ts)
- Compatibility tests: [`tests/contracts/corpus-v1.test.ts`](../../tests/contracts/corpus-v1.test.ts)

## Context

MCAA-237 introduces remote client mode: a Postgres-backed, multi-tenant server
where the API key is the tenant binding, plus a cross-tenant `shared` scope on
observations (`observations.shared`, the `memories:write:shared` grant, and the
`scope: 'project' | 'shared'` read opt-in on `POST /v1/search`, `POST /v1/context`
and the `/v1/mcp` recall tools).

**Ordering dependency, stated because this contract is built entirely on top of
it:** that work lives on `automation/mcaa-237-remote-client-mode` and is *not yet
merged*. The branch carrying this ADR is not a descendant of it, and
`src/storage/postgres/schema.ts` here still has no `shared` column. Everything
below assumes those three primitives exist. The compatibility tests pass today
because the contract is data -- zod schemas and constants -- and asserting them
needs no database. **Implementation of this contract cannot merge before
MCAA-237 does.**

The knowledge-corpus subsystem was the one deliverable it did not cover. Today
that subsystem is entirely worker-local:

- `src/services/worker/knowledge/` -- `CorpusStore` writes one
  `<name>.corpus.json` file per corpus into a local directory; `CorpusBuilder`
  queries local SQLite through `SearchOrchestrator` and materialises the matched
  observations *by value* into that file; `KnowledgeAgent.prime()` starts a
  Claude Agent SDK session, stores its `session_id` in the corpus file, and
  `query()` resumes that session.
- `src/services/worker/http/routes/CorpusRoutes.ts` -- `POST/GET /api/corpus`,
  `GET/DELETE /api/corpus/:name`, and `POST /api/corpus/:name/{rebuild,prime,query,reprime}`.
- `src/servers/mcp-server.ts` -- the stdio tools `build_corpus`, `list_corpora`,
  `prime_corpus`, `query_corpus`, `rebuild_corpus`, `reprime_corpus`, each of
  which calls `callWorker(...)`.

Three properties of that design do not survive the move to a replicated,
multi-tenant server, so this is not a port:

1. **A corpus file is a global singleton.** The store addresses corpora by
   filename, so `argocd` means one thing per install. On the server it must mean
   one thing per tenant.
2. **A corpus embeds copies of observations.** `CorpusFile.observations[]` is a
   snapshot of row content. Copy semantics plus a cross-tenant shared scope is a
   disclosure channel, and it makes `DELETE /v1/memories/:id` a lie.
3. **`prime_corpus` creates a live AI session that `query_corpus` resumes.** That
   assumes one long-lived local process. Behind a load balancer, the replica that
   primed is not the replica that serves the next query, and a rolling restart
   destroys every session.

There is also a live gap worth naming: in remote mode the stdio corpus tools
still call `callWorker()`, and remote mode deliberately starts no worker. Those
six tools currently dead-end with a connection error. Fixing that is part of the
implementation this ADR unblocks.

The server's own observation shape is much flatter than the local one. Local
corpora filter on `types`, `concepts`, `files` -- columns that exist in SQLite.
The Postgres `observations` row is `(id, project_id, team_id, server_session_id,
kind, content, content_search, generation_key, metadata, embedding, shared, ...)`.
Concepts and files are not columns there; at best they live inside `metadata`.
A filter ported field-for-field would silently match nothing.

## Decision

### D1 -- A corpus is tenant-owned, addressed by `(team, project, name)`

New tables, following the existing composite-FK tenancy convention used by
`agent_events` and `observations` (TEXT ids, `FOREIGN KEY (project_id, team_id)
REFERENCES projects(id, team_id)`), so a corpus physically cannot straddle
tenants:

```sql
CREATE TABLE IF NOT EXISTS corpora (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  filter_digest TEXT NOT NULL,
  member_scope TEXT NOT NULL DEFAULT 'project'
    CHECK (member_scope IN ('project', 'shared')),
  shared BOOLEAN NOT NULL DEFAULT false,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  built_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, project_id, name),
  UNIQUE (id, project_id, team_id),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS corpus_members (
  corpus_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  PRIMARY KEY (corpus_id, observation_id),
  FOREIGN KEY (corpus_id, project_id, team_id)
    REFERENCES corpora(id, project_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS corpus_artifacts (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  content_digest TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  rendered TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  primed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (corpus_id, content_digest)
);

CREATE INDEX IF NOT EXISTS idx_corpora_shared
  ON corpora(shared, updated_at DESC) WHERE shared;

-- Postgres does not index a referencing FK column automatically, so without this
-- the observations -> corpus_members cascade sequential-scans corpus_members on
-- every DELETE /v1/memories/:id, and once per row for DELETE .../memory.
CREATE INDEX IF NOT EXISTS idx_corpus_members_observation
  ON corpus_members(observation_id);

-- metadataMatch is the documented substitute for the local concepts/files filter
-- and runs inside a synchronous build request; unindexed it is a containment scan.
CREATE INDEX IF NOT EXISTS idx_observations_metadata
  ON observations USING GIN (metadata jsonb_path_ops);
```

`corpus_members` carries `project_id`/`team_id` and a composite FK back to
`corpora(id, project_id, team_id)`, which is what the otherwise-unused
`UNIQUE (id, project_id, team_id)` on `corpora` is for. It makes a member row
physically unable to belong to a corpus in another tenant. Note the limit of that
guarantee: it constrains the *membership edge*, not the observation. `observations`
has only `id TEXT PRIMARY KEY` with no `UNIQUE (id, project_id, team_id)`, so no
composite FK to the observation is possible; that half stays application-enforced
(see D3).

There is deliberately **no `position` column.** Render order is derived from
`(observations.created_at, observations.id)` -- see `CORPUS_MEMBER_ORDER`. A stored
position can be duplicated or gapped by a buggy rebuild, and because order feeds
the content digest that would mean a nondeterministic cache key. Deriving it makes
that class of bug impossible rather than merely unlikely.

`name` keeps the existing `^[a-zA-Z0-9._-]+$` validation and stays the
client-facing identifier, because that is how humans and agents refer to a
corpus; `UNIQUE (team_id, project_id, name)` makes that safe. `id` exists for
audit rows and for a future rename.

Canonical REST path is therefore project-scoped, matching the existing
`/v1/projects/:projectId/jobs` and `DELETE /v1/projects/:projectId/memory`
precedent: **`/v1/projects/:projectId/corpora[/:name]`**. The team comes from the
key and is never accepted from the client. `ensureProjectAllowed()` still
applies, so a project-scoped key touching another project's corpus gets the same
`403` it already gets elsewhere.

**Plus an id-addressed read companion, because a name is not a cross-tenant
identity.** `name` is unique only per `(team_id, project_id)`, and every
project-scoped route runs `ensureProjectAllowed()` and answers `404` for a
cross-tenant `:name`. So the project-scoped path alone can list foreign shared
corpora via `?scope=shared` but can never read or query one -- which would make
that list parameter dead weight. Corpora cannot borrow the shared-observation
precedent here: shared observations are only ever reached through collection reads
(`POST /v1/search`, `POST /v1/context`) that return content inline, and there is no
`GET /v1/memories/:id` to copy. A corpus summary with no query route is useless.

Hence two additional routes, read-only by construction:

- `GET /v1/corpora/:corpusId`
- `POST /v1/corpora/:corpusId/query`

Visible for own-tenant rows always, and for another tenant's row only when
`shared = true`; anything else is `404`, never `403`, so a probe cannot confirm an
id exists. There is deliberately no id-addressed build, rebuild, prime, reprime or
delete -- mutating another tenant's corpus is not a capability this contract grants,
and for your own corpus the project-scoped path already works. This is also what
finally makes the `id` column useful beyond audit rows.

### D2 -- Membership is stored by reference, never by value

`corpus_members` holds observation ids. Rendering resolves the rows at
prime/render time and re-applies the same tenant predicate used by
`PostgresObservationRepository.search()`.

This is the single most important departure from the local design, and it buys
three things at once: `DELETE /v1/memories/:id` propagates (via `ON DELETE
CASCADE`), un-sharing an observation propagates, and a read can never return a
row the caller is not currently entitled to -- even if it was entitled when the
corpus was built. The cost is that a corpus is no longer a frozen snapshot; a
corpus that loses members reports a lower `observationCount` on its next render.
That is the correct trade: a knowledge base that keeps serving deleted content is
a defect, not a feature.

**`corpus_artifacts` is the exception, and it must be treated as one.** By design
it holds `rendered` and `system_prompt` -- that *is* observation content, copied by
value. So "membership by reference" secures `corpora` and `corpus_members` while
the cache quietly reintroduces exactly the problem D2 exists to solve. The failure
is concrete: `DELETE /v1/memories/:id` cascades `corpus_members` **at the database
level**, bypassing application code entirely, and leaves the deleted
observation's text in `corpus_artifacts` indefinitely. "Forget this one
observation" would not forget it.

Two rules close that, and neither is optional:

1. **Servability is the digest, never recency.** `query` MUST recompute the content
   digest from live membership on every request and MUST refuse to serve a stored
   artifact whose digest differs. Serving the newest artifact by `primed_at` is the
   optimisation an implementer naturally reaches for, and it is wrong. This is
   enforceable, not advisory: `corpusContentDigest()` and `isArtifactServable()`
   are in the contract module with tests.
2. **Artifacts are purged when the member set changes**, by trigger or by an
   explicit purge in the delete path. An application-level purge alone is not
   enough, because it never fires behind a DDL cascade. Retention is additionally
   bounded by `MAX_ARTIFACTS_PER_CORPUS`, which caps how long any superseded render
   can linger.

The honest consequence: a deleted observation's text can survive in a cache row
until purge, but it can never be *served*, because the digest no longer matches.
Rule 1 is the security property; rule 2 is hygiene and bounds the exposure window.

### D3 -- A shared corpus may contain only already-shared observations

A corpus is team-private by default. `shared: true` requires the existing
`memories:write:shared` grant, exactly like an observation.

The obvious naive rule -- "a shared corpus exposes its rendered knowledge but not
its sources" -- is rejected. It does not hold: `query_corpus` returns model text
derived from the member rows, so a shared corpus over private observations
exfiltrates them anyway, in an unauditable form. Hiding the sources makes that
worse by removing the audit trail, not better.

So the invariant is enforced on the member set instead:

> A corpus with `shared = true` may only have members whose own
> `observations.shared` is `true`.

Enforced server-side at build **and** rebuild, not only at publish. A build that
requests `shared: true` while its filter admits private rows is rejected with
`422 SharedCorpusPrivateMembers` carrying the disqualifying count -- it is not
silently filtered down, and it is not silently downgraded to private. Fail loud,
like the rest of remote mode.

#### The member predicate is a narrowing, and it is not a scope

An earlier revision of D5 described this as "scope forced to `shared`". That
wording is actively dangerous, because `scope: 'shared'` means the opposite
everywhere else in this codebase: it *widens*. The existing read predicate in
`PostgresObservationRepository.search()` is

```sql
(observations.project_id = $1 AND observations.team_id = $2) OR ($6 AND observations.shared)
```

-- with the shared opt-in on, that **includes the caller's own private rows**. An
implementer told to "force scope to shared" and reuse that predicate would select
their own private observations straight into a published corpus. That is precisely
the failure this ADR names as its worst case.

So the contract names three distinct predicates
(`CORPUS_MEMBER_PREDICATES`), and the third is a *conjunct*, not a scope:

| Name | Predicate | Used for |
| --- | --- | --- |
| `ownTenant` | `project_id = $p AND team_id = $t` | default reads |
| `ownTenantOrShared` | `(project_id = $p AND team_id = $t) OR shared` | reads with the shared opt-in -- **admits own private rows** |
| `publishable` | `((project_id = $p AND team_id = $t) OR shared) AND shared` | member selection for a corpus with `shared = true` |

Tests assert that `publishable` is distinct from the read predicate and carries an
explicit `AND observations.shared`. Do not describe it as a scope anywhere.

#### Enforcement is atomic, and only partly structural

Validate-then-insert admits a private member if anything interleaves between the
check and the insert. So the build is specified as a **single statement**:

```sql
INSERT INTO corpus_members (corpus_id, project_id, team_id, observation_id)
SELECT $corpusId, $projectId, $teamId, observations.id
FROM observations
WHERE <filter> AND <publishable predicate>
FOR SHARE OF observations;
```

`FOR SHARE` holds the member rows for the transaction so they cannot change
underneath it. The count for the `422` comes from the same transaction.

Being precise about how strong this is, because an earlier revision overstated it:
the `corpora` row's tenancy *is* structural (composite FK), and so is the
membership edge's (D1). The D3 invariant itself -- every member is `shared` -- is
**application-enforced**, and cannot be made structural, because `observations` has
no `UNIQUE (id, project_id, team_id)` for a composite FK to reference and Postgres
cannot express "referenced row has `shared = true`" as a constraint. Saying
otherwise would let a future reader skip the test that actually carries the load.

With the invariant in place, exposing a foreign shared corpus's **content** is safe
by construction: any reader could already fetch the same content with
`POST /v1/search { "scope": "shared" }`.

**Revision 3 correction -- the invariant covers content, not provenance.**
Revisions 1-2 stated the sentence above about "sources" rather than "content", and
drew the conclusion that a member row could be returned whole. That was wrong, and
it was wrong on its own terms even before MCAA-281: `observations.shared` says the
*content* may cross a tenant boundary. It says nothing about `project_id` (free
text the publisher chose, usually a repository or directory name) or `metadata`
(publisher-controlled JSON that the write path stamps with the publishing agent's
id). Publishing content is not publishing who published it.

MCAA-281 makes that explicit for observations: `POST /v1/search`, `POST /v1/context`
and the recall tools now project any row reached through the shared branch down to
content plus an opaque origin token. The "same rows a shared search would return"
equivalence therefore no longer licenses returning the stored row -- it licenses
returning the *projection* of it. Any corpus surface that returns more is a way
around that projection. D9 states the rule; conditions 10-13 are what enforce it.

Worth recording why the build-time invariant is currently airtight: there is **no
`UPDATE observations` statement anywhere in the repository.** Observations are
insert-or-delete only, so `shared` cannot go stale today. That is the load the
invariant is actually carrying, and it is a property of today's code rather than of
this design -- which is exactly why the next paragraph is a precondition and not a
note.

**Hard precondition on any future un-share path.** If `shared` ever becomes
mutable, that change must, in the same transaction, re-validate or demote every
shared corpus holding the affected row. D2 makes the row vanish from *renders*; two
things would otherwise go stale -- the corpus's `shared` flag, and any cached
artifact. The artifact case is why `shared` is part of the content digest (see D4):
without it, an un-share changes neither the member ids nor their `updated_at`, the
digest is unchanged, and a foreign reader keeps receiving the un-shared row's
content as model text with no audit trail. The existing upsert makes this concrete
rather than theoretical -- it is deliberately
`ON CONFLICT ... DO UPDATE SET updated_at = observations.updated_at`, so the house
pattern is *not* to bump `updated_at`. A digest keyed on timestamps alone would be
trusting a field the codebase intentionally freezes.

### D4 -- The primed session becomes a persisted, deterministic artifact

Options considered:

| Option | Verdict |
| --- | --- |
| **(a) Server-side session affinity** -- sticky-route queries to the replica holding the SDK session | Rejected. Pushes stickiness into the ingress and Helm contract, loses every primed session on a rolling restart, and makes a replica's memory part of the API's correctness. Fails *idempotent reconciliation*. |
| **(b) Stateless re-prime per query** -- re-run the select and the render on every question | Correct and replica-agnostic. Rejected for recomputation cost and nondeterminism, **not** for token cost -- see below. |
| **(c) Persisted primed artifact** -- `prime` materialises a durable, digest-keyed rendering; every query is a stateless read against it | **Chosen.** |

`prime_corpus` no longer opens an AI session. It renders the member set into
`corpus_artifacts` (system prompt, rendered text, token estimate) keyed by
`content_digest` over the ordered member **ids, their `updated_at`, and their
`shared` flag**. Priming stops being an LLM operation at all: it is deterministic,
cheap, and repeatable, so priming twice over an unchanged member set yields the same
digest and writes no new row.

`shared` is in the digest input deliberately, and its absence would be a
cross-tenant disclosure bug rather than a missed optimisation -- see D3's
precondition for why. The digest is computed by `corpusContentDigest()` in the
contract module rather than described in prose, so "an un-share changes the digest"
is a test, not an intention.

`query_corpus` is then a read that any replica can serve from Postgres.

**Why (c) over (b), stated correctly.** An earlier revision claimed (b) "pays the
full corpus token cost per question" while (c) is cheap because of prompt caching.
That comparison is wrong and should not be repeated: **(c) sends the model exactly
the same tokens as (b).** The only difference is where the rendered text lives
between requests, and prompt caching applies equally to both. The real advantages of
(c) are narrower and worth having on their own:

- **No recomputation per query.** (b) re-runs the member select (up to
  `maxMembers` rows) and the render on every question; (c) does it once per
  membership change.
- **Determinism.** One digest identifies one exact rendering, so two replicas
  answering the same question see byte-identical context. Under (b) any drift in
  the select or the renderer changes the prompt silently.
- **An observable cost.** `token_estimate` is stored per artifact, so corpus cost is
  a number you can alert on before a query fails, rather than a surprise.

On caching specifically, do not assume it pays off -- the economics cut both ways.
Cache *writes* cost more than an uncached call (1.25x base input at the 5-minute
TTL, 2x at 1-hour) while reads are ~0.1x, so break-even is roughly the second
request on the 5-minute TTL and the third on 1-hour. The default TTL is 5 minutes
measured from the *start* of the writing request, so generation time eats into it,
and the "ask a corpus something occasionally" pattern will usually miss the window.
The minimum cacheable prefix is model-dependent (512 tokens on Opus 5, up to 4096 on
others), and a shorter prefix silently does not cache at all -- so a small corpus
gets no benefit and a one-shot question against a cold corpus is *more* expensive
with caching than without. Caches are per-model, and here also effectively
per-tenant-per-corpus.

Consequence: caching is an optimisation to be measured, not an assumption this
design rests on. Whoever turns it on commits to reading
`usage.cache_read_input_tokens` and choosing the TTL from the observed
start-to-start gap between queries. The correctness argument for (c) is
replica-agnosticism and determinism; the cost argument is recomputation avoided.

**And `query` is not a pure read.** Per D2 it must recompute the digest from live
membership on every request, which costs a member-set read of up to `maxMembers`
rows even on a cache hit. That is the honest price of "any replica can serve it",
and it is the floor on query latency.

Two consequences follow, and both are deliberate:

- **There is no server-side conversation history.** Each query is independent. A
  client that wants a multi-turn conversation passes prior turns explicitly via
  `history`. The client owns the conversation; the server stays stateless. This
  is a real semantic change from local behaviour, where `query_corpus` resumed a
  session and accumulated context implicitly.
- **`prime` is optional.** If a query finds no current artifact it renders one
  in-memory for that request and persists it best-effort; a failure to persist
  does not fail the query. So a read-only key never gets a "not primed" error,
  and the system converges from any starting state. `prime` remains available as
  a warm-up that pre-pays the rendering.

`reprime_corpus` invalidates the stored artifact and re-materialises it. Under
this model it no longer clears drifted Q&A context (there is none to clear); it
is a cache-invalidation operation, and its tool description must say so.

### D5 -- The filter is expressed in terms the server actually has

Local `CorpusFilter` fields map as follows. Anything unsupported is **rejected**
with `400 ValidationError`, never accepted-and-ignored:

| Local field | Remote field | Notes |
| --- | --- | --- |
| `project` | path `:projectId` | Tenant-checked, not a filter. |
| `types` | `kinds?: string[]` | Maps to `observations.kind`. The local nine-value enum does not apply; server `kind` is free-form (`observation`, `manual`, ...). |
| `query` | `query?: string` | `content_search @@ websearch_to_tsquery('english', ...)`, as `POST /v1/search`. |
| `date_start` / `date_end` | `dateStartEpoch?` / `dateEndEpoch?` | Epoch ms, matching the existing `*AtEpoch` convention on the wire. |
| `limit` | `limit?: number` | Default 500, max 2000. Keeps the **newest** matches; truncation is reported, never silent (see below). |
| `concepts` | `metadataMatch?: Record<string, unknown>` | No column exists. JSONB containment against `metadata`. |
| `files` | `metadataMatch?` | Same. |
| -- | `platformSource?: string \| null` | New; mirrors `/v1/search`. |
| -- | `scope?: 'project' \| 'shared'` | Candidate-row **breadth** only. When `shared: true`, the `publishable` conjunct additionally narrows to shared rows -- that narrowing is not a scope value, see D3. |

Build is **synchronous**. It is a SQL select plus an insert of member references
and a deterministic render -- no model call (D4), so no job queue is warranted.
Not inventing a new job type here is deliberate; if profiling later shows builds
exceeding the request budget, the existing `observation_generation_jobs` pattern
plus `?wait=true` is the reversible next step.

#### Two ceilings, and truncation that is never silent

**Rows.** A filter matching more than `maxMembers` (2000) is rejected with
`422 CorpusTooLarge` (`reason: 'members'`) and the matched count, so the client
narrows rather than the server silently truncating. The match count MUST therefore be
computed **before** `limit` is applied -- otherwise `limit`, which zod caps at
`maxMembers` anyway, would clamp the count and the rejection could never fire.

**Tokens.** Rows are not tokens: 2000 short observations and 2000 long ones differ by
orders of magnitude, so a row-only ceiling lets a build succeed and produce a corpus
that can never be queried -- surfacing much later as an opaque provider `400`, far
from its cause. A build whose `token_estimate` exceeds `maxTokens` is therefore
rejected with `422 CorpusTooLarge` (`reason: 'tokens'`). The `reason` discriminator
is required because the two ceilings need different client fixes: narrow the filter
versus reduce content volume. Checked at build and rebuild, where the estimate is
computed anyway and a loud failure is cheap.

**`limit` truncation is legitimate but must be visible.** Rejecting at 2000 while
quietly dropping rows at the default 500 would be the same silent truncation this
decision rejects, just at a lower threshold. So two things are pinned rather than
left to the implementation:

- **Which rows survive:** `limit` keeps the **newest** matches
  (`CORPUS_LIMIT_SELECTION = 'newest'`), because recent knowledge is the useful end
  of the range. Unpinned, "keep 500 of 1500" is the difference between a useful
  corpus and a useless one.
- **What the client is told:** the corpus reports `matchedCount` and `truncated`
  alongside `observationCount`. Both fields are required, so an implementation
  cannot omit the evidence.

Render order stays oldest-first (`CORPUS_MEMBER_ORDER`), reproducing the local
`orderBy: 'date_asc'`. Selecting the newest and rendering oldest-first is
intentional, not a contradiction: selection picks *which* knowledge, order gives it
chronology.

### D6 -- Endpoints, and read vs write

| Endpoint | Scope required | Notes |
| --- | --- | --- |
| `POST /v1/projects/:projectId/corpora` | `memories:write` (+ `memories:write:shared` when `shared: true`) | Build. `201` on create, `200` on rebuild-in-place of an existing name. |
| `GET /v1/projects/:projectId/corpora` | `memories:read` | List. `?scope=shared` also lists corpora other tenants published. |
| `GET /v1/projects/:projectId/corpora/:name` | `memories:read` | Metadata. `?include=sources` adds resolved member rows. |
| `POST /v1/projects/:projectId/corpora/:name/rebuild` | `memories:write` | Re-runs the stored filter. Re-validates D3. |
| `POST /v1/projects/:projectId/corpora/:name/prime` | `memories:write` | Materialises the artifact. Persists a row, hence a write. |
| `POST /v1/projects/:projectId/corpora/:name/query` | `memories:read` | Stateless answer. Never mutates user-visible state. |
| `POST /v1/projects/:projectId/corpora/:name/reprime` | `memories:write` | Invalidate + re-materialise. |
| `DELETE /v1/projects/:projectId/corpora/:name` | `memories:write` | Parity with the local API. Cascades members and artifacts; never touches observations. |
| `GET /v1/corpora/:corpusId` | `memories:read` | Id-addressed read for a corpus discovered via `scope=shared` (D1). Own-tenant or published only. |
| `POST /v1/corpora/:corpusId/query` | `memories:read` | Id-addressed query, same visibility rule. |

Error shapes reuse the existing server vocabulary exactly -- `400 {error:
'ValidationError', issues}`, `403 {error: 'Forbidden', message}`, `404 {error:
'NotFound', message}`, `500 {error: 'InternalError', message}` -- plus two new
`422 {error, message, ...}` codes, `CorpusTooLarge` and
`SharedCorpusPrivateMembers`. A cross-tenant `:name` answers `404`, not `403`,
following the existing `scopeMismatch: 'not-found'` rule so existence is not
disclosed. Every read and write audits through `auditWrite()` with the scope
that was used, like the recall paths.

Delivery and ordering guarantees, stated rather than left to assumption:
build/rebuild/prime/reprime are **idempotent** writes keyed by
`(team_id, project_id, name)` and `filter_digest` / `content_digest`; repeating
one converges instead of duplicating. `query` is a plain **at-most-once**
request/reply with no server-side retry, and answers are model-generated, so a
client retry may legitimately return different text. Members render oldest-first by
`CORPUS_MEMBER_ORDER`, reproducing the local `orderBy: 'date_asc'`.

`query`'s best-effort artifact write is a cache write, not user-visible state, and it
is idempotent under `UNIQUE (corpus_id, content_digest)` -- so classifying `query` as
`memories:read` and as at-most-once stays honest even though it can touch the
database.

### D7 -- MCP tool names stay identical across local and remote

The `/v1/mcp` surface gains `build_corpus`, `list_corpora`, `get_corpus`,
`prime_corpus`, `query_corpus`, `rebuild_corpus`, `reprime_corpus`,
`delete_corpus` -- the *same names* the local stdio server already exposes, even
though the neighbouring remote tools are bare verbs (`search`, `context`,
`recent`). Shared bones beat local naming aesthetics: a skill or prompt that
says "call `prime_corpus`" must work in both modes without a translation table.

**How far that parity actually goes, since overstating it would mislead.** Name
parity is real, and for the five name-only tools (`prime`, `query`, `rebuild`,
`reprime`, plus `list_corpora`) argument parity is real too. For `build_corpus` it is
not: local takes `types`/`concepts`/`files` as comma-separated strings with ISO
`dateStart`/`dateEnd` and `project`, and allows unknown properties; remote takes
`kinds` as an array, `metadataMatch` as an object, `dateStartEpoch`/`dateEndEpoch` as
integers and `projectId`, and rejects unknown properties. A skill that calls
`build_corpus` with `types` hard-fails remotely. The translation table D7 claims to
avoid therefore exists for exactly one tool -- the only corpus tool with real
arguments. The failure is at least loud rather than silent, which is why this is
acceptable rather than blocking, but it should not be discovered by surprise.

`get_corpus` and `query_corpus` additionally accept `corpusId` as an alternative to
`name`, for a corpus discovered through `list_corpora` with `scope: 'shared'`
(see D1). Exactly one of the two is required -- accepting both would leave precedence
to guesswork. This relaxes those two tools' required-argument sets from `['name']`
and `['name', 'question']`, which keeps every previously valid call valid; the
frozen-args test was updated deliberately, and still fails on the two breaking
directions, a rename and a newly-required argument.

`projectId` is **optional** in the tool schema in both modes and resolved from
context (local: cwd project; remote: `CLAUDE_MEM_PROJECT_ID`). A remote call with
neither errors naming the missing variable, consistent with the remote-mode
never-falls-back rule. Keeping it optional is what lets one schema serve both
modes.

The `scope: 'project' | 'shared'` opt-in appears **only where it means
something**: on `build_corpus` (which rows may become members) and on
`list_corpora` (discovery of other tenants' published corpora). It is *not* on
`get_corpus`, `query_corpus`, `prime_corpus`, `rebuild_corpus` or
`reprime_corpus` -- those act on one corpus row whose scope was already fixed at
build time, so a `scope` argument there would be inert and misleading. As
elsewhere, an unrecognised scope value narrows to `project` in MCP and `400`s in
REST; neither ever widens a read.

### D8 -- Nothing here breaks the local worker API

The local `/api/corpus*` routes, `CorpusFile` shape, and stdio tool behaviour are
unchanged. The remote surface is additive under `/v1`, so no `/v2` and no version
bump. Three compatibility rules keep it that way, and the tests in
`tests/contracts/corpus-v1.test.ts` pin them:

1. **The remote corpus representation is a new representation, not a superset of
   the local one.** An earlier revision claimed "additive fields only... removes
   nothing a local consumer reads". That was simply false, and it is the one claim in
   this document a future reader would have relied on and been wrong. The facts:
   local corpus metadata is `{version, name, description, created_at, updated_at,
   filter, stats, system_prompt, session_id}` with
   `stats = {observation_count, token_estimate, date_range: {earliest, latest},
   type_breakdown}`. Remote `CorpusSummarySchema` is `.strict()` and renames or
   retypes every one of those -- `observationCount`, `tokenEstimate`,
   `kindBreakdown`, `earliestAtEpoch`/`latestAtEpoch` as epoch integers instead of
   ISO strings -- and drops `version` and `system_prompt` entirely. `stats` survives
   as a key name but shares no leaf with the local shape. Local `prime`/`reprime`
   return a top-level `{session_id, name}`; the remote response nests `name` under
   `corpus` and is strict, so a local client reading `response.name` gets
   `undefined`. `session_id` is the only leaf preserved by name and type.

   This is a defensible choice -- the remote surface is a *different resource* under a
   different path, not a version of the local one, and nothing consumes both -- but it
   is a new representation and is documented as such. A test asserts the specific
   renames and drops, so this paragraph cannot rot back into "additive only".
2. **`session_id` is nullable, not removed.** Remote `prime`/`query`/`reprime`
   responses return `session_id: null` rather than omitting the field, so a
   client that reads it gets a defined value with an honest meaning: this server
   holds no resumable session. Local keeps returning a real id. This is the one
   genuine cross-mode compatibility affordance, which is why rule 1 had to stop
   claiming credit for others.
3. **Tool names and required arguments are frozen** by a golden test -- and the test
   now actually freezes them. Previously it compared each tool's `required` against a
   constant *in the same module*, so both were edited together: a self-consistency
   check, not a freeze. And it asserted local parity against a hardcoded list of
   names, so renaming a **local** tool passed silently -- the direction that actually
   breaks a skill. Now the expected required-args literal is inlined in the test, and
   local parity is asserted against the corpus tool names parsed out of
   `src/servers/mcp-server.ts` itself. Adding an optional argument passes; renaming a
   tool on either side, or promoting an argument to required, fails.

The contract itself is versioned in code as `CORPUS_CONTRACT_VERSION = 1` in
`src/server/contracts/corpus-v1.ts`. A future incompatible change adds
`corpus-v2.ts` beside it and keeps v1 serving.

### D9 -- Provenance is projected per member, at one shared boundary

Added in revision 3. D3 establishes *what content* may cross a tenant boundary;
this decides *what else travels with it*, and where that decision lives.

**The rule.** Every observation a corpus surface returns or renders is projected by
the same function the observation surfaces use, and the projection is decided **per
member row**, against the reader, not per corpus:

> A member row keeps full fidelity only when the reader owns it through their own
> tenant predicate -- same `team_id` **and** same `project_id` as the read. Every
> other row is reduced to published content plus `sharedOrigin`. `project_id`,
> `metadata` and `serverSessionId` do not cross that boundary, in a JSON response
> or in rendered artifact text.

Three things about that wording are the decision, and each of them is a mistake
that was actually made:

1. **Per member, not per corpus.** `foreign = corpus.team_id != caller.team_id` is
   the wrong test. `build_corpus` with `scope: 'shared'` admits other tenants'
   shared rows into a corpus the caller *owns* -- that is the documented breadth
   (D5) and needs only `memories:read`/`memories:write`, not the shared-write grant.
   A per-corpus flag calls that corpus non-foreign and hands back every foreign
   member's `projectId` and `metadata` in full. Republishing then becomes the
   bypass, which is exactly what revision 2 wrongly accepted as harmless (see
   "Second review", retraction). Foreignness is a property of the row-reader pair.
2. **Project as well as team.** MCAA-281 treats same team, different project as
   *not* owned, because the row was only reachable through the shared opt-in, and
   because a project-scoped API key gets a `403` on its sibling project's
   endpoints. A corpus boundary drawn on `team_id` alone re-opens the read that
   `ensureProjectAllowed()` refuses.
3. **One implementation.** The projection lives in
   `src/server/routes/v1/observation-projection.ts` (MCAA-281) and the corpus path
   imports it. Two copies of one redaction rule is the failure mode this ADR keeps
   naming: the copy someone forgets is the leak. This is the shared-bones rule
   applied inside a single service, and it is why condition 12 is a reuse
   requirement rather than a behaviour requirement.

**`sharedOrigin`, and why it must land before v1 ships.** A projected member row
carries `sharedOrigin` -- MCAA-281's stable digest over `(team_id, project_id)`,
truncated, imported rather than recomputed. Without it a reader cannot tell whether
forty projected rows came from one publisher or forty, which is the grouping signal
the observation surfaces already concede; withholding it on the corpus surface
while granting it on search is the same divergence as (3).

It cannot be deferred. Every response schema in `corpus-v1.ts` is `.strict()`, so a
consumer that pins the v1 schema **rejects** a response carrying a key the schema
does not list. Under `.strict()`, adding a field is a breaking change for pinned
consumers, not an additive one. The contract's "additive by default" default
therefore does not apply to these schemas, and the full projected field set has to
be right at v1 or wait for `corpus-v2.ts`.

**Corpus-level fields.** The corpus's own `name` and `description` stay -- they are
author-chosen text on a row the author deliberately published, and revision 2
already reasoned that through. `filter` does not: it is build-time configuration,
never published content, and `filter.metadataMatch` carries the literal metadata
keys *and values* the member projection just removed, which makes returning it a
direct contradiction rather than a judgment call. On a foreign read, `filter` is
omitted from the response and the render's system prompt drops `query`, `kinds` and
`platformSource`. `filterDigest` stays: it is opaque, and it is the only handle a
reader has for noticing that a corpus was rebuilt under them.

**Versioning.** None of this bumps `CORPUS_CONTRACT_VERSION`. `corpus-v1.ts` has not
shipped -- MCAA-259 is still an open PR, there is no released client, so the
"consumer you cannot see and cannot redeploy" does not exist yet. That window is the
entire licence for narrowing required fields to optional, and it closes at the first
release. After that, moving a field out of a response, or into one, is `corpus-v2.ts`.

**Blast radius.** A missed projection leaks publisher identity, not content: which
tenant and project authored knowledge that was already publishable, plus whatever
the publisher's generators wrote into `metadata`. It does not disclose unshared
content -- D3 still holds that line. It travels as far as any tenant with a read
key, and it is not recoverable once served.

## Consequences

**Good**

- Tenant isolation of the corpus row and of the membership edge is **structural**:
  composite FKs mean a corpus cannot straddle tenants and a member row cannot belong
  to a corpus in another tenant. The D3 shared-member invariant is **application-
  enforced** and cannot be made structural (D3 explains why). Both halves are stated
  because conflating them is how the invariant's test gets treated as optional.
- The server scales horizontally with no sticky routing, and a cold replica can
  answer any query.
- Priming is deterministic and model-free, so it is cheap to test and its cost is
  predictable.
- Deletion and un-sharing propagate into knowledge bases automatically.
- One tool vocabulary across homelab and enterprise.

**Costs and risks, named**

- A corpus is no longer a reproducible snapshot; content can change under it.
  Anyone needing a frozen citation must record observation ids themselves.
- Multi-turn corpus conversations become the client's job. Existing local users
  of implicit session continuity lose it in remote mode; the tool descriptions
  must say so plainly.
- Query cost is the full corpus prefix per question unless prompt caching happens to
  land, and caching is not free (D4 has the numbers: a cold one-shot query is
  *more* expensive with caching than without). The `token_estimate` on the artifact is
  what makes the exposure visible; choosing a TTL from measured
  `usage.cache_read_input_tokens` and alerting on cost belongs with the SRE &
  Observability Engineer.
- Every query pays a live member-set read (up to `maxMembers` rows) to recompute the
  digest, even on a cache hit. That is the floor on query latency and the price of
  replica-agnostic correctness.
- Corpus build/publish/delete emit **no domain events**, while comparable state
  changes on this platform are observable. `auditWrite()` covers the audit trail, so
  this is not a v1 blocker, but it is a known gap. Adding events later is purely
  additive on existing infrastructure -- no new broker, no further ADR -- and is the
  natural mechanism for D3's deferred un-share fan-out.
- `metadataMatch` is a weaker substitute for local `concepts`/`files` filtering
  and only works if generators actually write those keys into `metadata`. That
  gap is real and belongs on the backlog, not hidden behind an accepted-and-ignored
  parameter.
- `maxMembers = 2000` is a guess. It is a server-side constant precisely so it
  can be raised without a contract change.
- Every response schema is `.strict()`, which buys a loud failure on a stray field
  and costs the ability to add one: for a consumer that pins the v1 schema, an added
  response key is a parse error. So "additive changes by default" does not hold for
  these schemas, and the field set has to be complete before the first release
  rather than grown afterwards (D9). Loosening the response schemas to recover
  additivity is a deliberate future option, not an oversight -- it trades away the
  detection of a field the server was never meant to send.

**Blast radius if this fails**

A corpus bug is contained to corpus endpoints: observations, ingest, search,
context and recent share no code path with it and keep working. The two genuinely
dangerous failure modes both concern disclosure, and both now have named, tested
mechanisms rather than prose:

1. **D3 enforced at publish time only** would turn `memories:write:shared` into a
   bulk-exfiltration channel for private observations. Negative contract test, and a
   distinguishable `422 SharedCorpusPrivateMembers`.
2. **An artifact served by recency instead of by digest** would keep answering from
   deleted or un-shared rows, as model text, with no audit trail. `isArtifactServable()`
   plus the `shared`-in-digest tests are what prevent it.
3. **Provenance projected per corpus instead of per member** (revision 3) would make
   `build_corpus { scope: 'shared' }` a one-call way around the observation
   projection, on an ordinary read/write key. It leaks publisher identity rather
   than content, so D3 still bounds it, but every tenant with a read key is in
   range. Condition 10's test -- read the sources of *your own* corpus built over
   shared rows -- is the one that catches it; a cross-tenant read test does not.

## Conditions on the implementing engineer

Blocking. Each one is a place where a correct-looking implementation would violate a
guarantee this ADR claims.

1. **Enforce D3 on build *and* rebuild**, as the single atomic
   `INSERT ... SELECT ... WHERE <publishable> FOR SHARE` in D3 -- not validate-then-insert.
   Include a test proving a rebuild cannot smuggle a newly-private row into an
   already-shared corpus.
2. **Never store observation content in `corpora` or `corpus_members`.**
   `corpus_artifacts` is the one by-value copy, and it carries both D2 rules with it:
   `query` recomputes the digest from live membership on every request and refuses a
   mismatched artifact, and artifacts are purged when the member set changes -- by
   trigger or in the delete path, because an application-level purge never fires
   behind the DDL cascade.
3. **Use `CORPUS_MEMBER_PREDICATES.publishable` for member selection on a shared
   corpus.** Do *not* reuse `PostgresObservationRepository.search()`'s predicate: with
   the shared opt-in it admits your own private rows, so following an earlier version
   of this condition literally would publish them. Do not call the narrowing a "scope".
4. **Include `shared` in the content digest** (`corpusContentDigest()`), and treat
   D3's un-share paragraph as a hard precondition on any future mutable-`shared` path,
   not as a note.
5. **Reject over both ceilings** -- `maxMembers` and `maxTokens` -- with the `reason`
   discriminator, counting matches *before* applying `limit`; and report `matchedCount`
   / `truncated` so `limit` truncation is never silent.
6. **Ship the id-addressed read routes** (`GET /v1/corpora/:corpusId`,
   `POST /v1/corpora/:corpusId/query`) in the same change as `?scope=shared` on the
   list surface. Shipping discovery without addressability makes the scope parameter
   dead weight. Read-only: no id-addressed mutation.
7. **Fix the remote-mode dead-end.** All six stdio corpus tools call `callWorker()`
   unconditionally and remote mode starts no worker, so all six currently fail with a
   connection error. They must go through the remote client when
   `CLAUDE_MEM_SERVER_URL` is set. Map remote errors onto the local tools' error text,
   or skills observe different failure strings per mode and the parity D7 buys is lost
   at the error path.
8. **Import the schemas from `src/server/contracts/corpus-v1.ts`** rather than
   retyping them, so the compatibility tests guard the shipped surface.
9. **A cross-tenant `:name` or `:corpusId` returns `404`, never `403`.**

Conditions 10-13 are added in revision 3, from the MCAA-345 review of MCAA-260.
They enforce D9.

10. **Decide the projection per member row, against the reader** -- never from a
    per-corpus `foreign` flag. A row is owned only when its `team_id` *and*
    `project_id` both match the read (`isOwnerAuthorizedView`). The test that proves
    it is not "read another tenant's shared corpus": it is **build your own corpus
    with `scope: 'shared'`, then read its sources**, and assert the foreign members
    come back projected. That path needs no shared-write grant.
    `tests/contracts/corpus-v1.test.ts` carries the schema half: a projected row
    parses, an owner row parses, and a projected row with `projectId` or `metadata`
    present is a contract violation the test names -- so "optional" cannot decay
    into "sometimes sent".
11. **Project the render, not just the JSON.** `corpus_artifacts` text is a by-value
    copy that `query` feeds to a model, so an unprojected render is the same leak
    one indirection further out. A corpus whose members are not all owner-authorized
    for the reader renders per reader and MUST NOT be read from or written to the
    artifact cache -- the cache key is the membership digest and carries no reader
    dimension, so a cached owner render would otherwise be served verbatim. Keep
    `prime`/`reprime` owner-only so the converse cannot happen either.
12. **Import `serializeObservationForViewer` / `isOwnerAuthorizedView` /
    `sharedOriginToken` from `src/server/routes/v1/observation-projection.ts`.** Do
    not re-derive the rule in `CorpusService` or `corpus-render`. If the corpus row
    shape genuinely needs to differ (it adds `position`; it has no
    `serverSessionId`), extend that module -- including its deliberately empty
    `SHARED_METADATA_ALLOWLIST` -- rather than forking it. Whichever of MCAA-260 and
    MCAA-281 merges second owns the convergence.
13. **Omit `filter` on a non-owner read**, and drop `query`, `kinds` and
    `platformSource` from the render's system prompt on the same reads.
    `filter.metadataMatch` carries the exact metadata keys and values the member
    projection removes; returning it undoes condition 10 in one field. Keep
    `filterDigest`.

Recommended, not blocking: the `corpus_members(observation_id)` and
`observations.metadata` GIN indexes in D1 (both are hot paths, not
micro-optimisations); `MAX_ARTIFACTS_PER_CORPUS` retention; and domain events for
build/publish/delete when the un-share fan-out lands.

## Second review

MCAA-264, Workflow & Eventing Engineer: **approve-with-conditions**, six blocking
findings, eleven further findings. What changed here as a result:

| Finding | Change |
| --- | --- |
| B1 -- `corpus_artifacts` is a by-value copy with no invalidation link | D2 gained the digest-revalidation and purge rules; `isArtifactServable()` added with tests |
| B2 -- `shared` missing from the digest input | Added to `corpusContentDigest()`; D3's un-share note promoted to a precondition |
| B3 -- condition #3 named a predicate that leaks own private rows | `CORPUS_MEMBER_PREDICATES` added; D3 renames the narrowing and stops calling it a scope |
| B4 -- validate-then-insert is not atomic; "structural" overstated | D3 specifies one `INSERT ... SELECT ... FOR SHARE`; the structural claim is split into what the schema does and does not enforce |
| B5 -- foreign shared corpora discoverable but not addressable | `GET /v1/corpora/:corpusId` and `POST /v1/corpora/:corpusId/query`; `corpusId` on the two read tools |
| B6 -- `maxMembers` bounds rows, not tokens | `MAX_CORPUS_TOKENS` plus a `reason` discriminator on `CorpusTooLarge` |
| D4 note -- the caching cost argument was not a real distinction | D4's rationale rewritten: (c) wins on recomputation, determinism and observability, not tokens |
| N1 -- rule 1 was factually wrong | D8 rule 1 rewritten as "a new representation", with a test pinning the renames and drops |
| N2 -- parity claim thinner than stated | D7 states that argument parity fails for `build_corpus` |
| N3 -- the golden test did not freeze | Required-args literal inlined in the test; local parity parsed from `mcp-server.ts` |
| N4 -- silent truncation at `limit`; ordering unspecified | `CORPUS_LIMIT_SELECTION`, `CORPUS_MEMBER_ORDER`, `matchedCount`/`truncated` |
| N5 -- two missing indexes | Both added to the D1 DDL |
| N6 -- unused composite unique on `corpora` | `corpus_members` now carries the composite FK that uses it |
| N7 -- `position` had no uniqueness | Column dropped; order derived from the observation columns |
| N8 -- unbounded query input on a read key | `MAX_QUESTION_CHARS`, `MAX_HISTORY_CONTENT_CHARS` |
| N9 -- no artifact retention policy | `MAX_ARTIFACTS_PER_CORPUS` |
| N10 -- no domain events | Named as a known gap and an additive extension seam |
| N11 -- MCAA-237 ordering dependency unstated | Stated in Context, including that the branch is not yet merged |

Two findings were probed and accepted rather than fixed: pasting private text into a
published corpus's `name`/`description` is not an escalation (the same key can create
a shared observation with the same text), and republishing another tenant's shared
rows discloses nothing a `scope: 'shared'` search would not already return.

**Retraction (revision 3).** The second of those is withdrawn. It was true only of
content, and it was read as covering the whole row: a corpus built with
`scope: 'shared'` holds other tenants' rows while belonging to the builder, so a
per-corpus ownership test returns those rows' `project_id` and `metadata` whole, and
renders their `metadata` into model text. MCAA-281 then makes the premise false
outright -- a `scope: 'shared'` search no longer returns those fields at all. What
the finding should have said is that republishing discloses no content a shared
search would not; the provenance question was not asked. D9 and conditions 10-13
answer it. Recorded rather than quietly edited, because this ADR is what an
implementer was reasoning from, and MCAA-260 implemented the sentence correctly.
