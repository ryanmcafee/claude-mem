# ADR 0002 -- Remote corpus (knowledge-base) API and MCP contract

- Status: Accepted (revision 7 -- conditions re-read against the implementation at
  `3b8f002f`; they bind on merging PR #7, per revision 6)
- Date: 2026-09-28 (revisions 3-7; revisions 1-2 dated 2026-09-27)
- Deciders: Principal Platform Architect
- Second reviewer, revision 2: Workflow & Eventing Engineer -- MCAA-264,
  *approve-with-conditions*. All six blocking conditions (B1-B6) are applied; see
  "Second review" below for what each one changed.
- Second reviewer, revision 3: Security & Secrets Engineer -- MCAA-348,
  *approve-with-conditions*, five blocking findings. All five are applied in
  revision 4; see "Second review of D9" below. D9 is a trust-boundary decision of
  the author's own, so it does not count as reviewed on his say-so.
- Tracking: MCAA-259, parent MCAA-237. Revision 3 arises from the MCAA-345 review
  of MCAA-260's implementation, against MCAA-281's observation projection;
  revision 4 from MCAA-348's review of revision 3; revision 5 from a conflict this
  ADR created with ADR 0001 (remote client mode and shared scope) over
  `sharedOrigin` -- see "Revision 5" below. No second review is required: it
  withdraws a requirement and adds no new boundary. Revision 6 moves conditions 10-17
  from a first-release gate to a merge gate on PR #7, on the reachability the Workflow
  & Eventing Engineer established. Revision 7 comes from MCAA-354 and changes no
  decision: it re-reads conditions 10-16 against the code, adds conditions 18-19 for
  what that re-read found, corrects one remaining blast-radius sentence, and pins the
  numbering below. No further second review is required for revision 7: it moves no
  boundary and loosens nothing. Condition 18 makes the contract express a requirement
  conditions 13 and 16 already imposed, and condition 19 is numbering hygiene.
- **Numbering, canonical.** This record is ADR **0002**. ADR **0001** is
  "Remote client mode, tenant binding and opt-in shared scope" (PR #6). MCAA-348's
  review cites this document as `0001-remote-corpus-api-and-mcp-contract.md` and
  MCAA-346 cites ADR 0001 as `0001-remote-client-mode-and-shared-scope.md`: both
  citations predate the renumbering in revision 5, and **only the second one still
  resolves**. Two open PRs carry this document at two paths -- PR #4 at
  `docs/adr/0002-...` (this file, revision 7) and PR #7 at
  `docs/adr/0001-remote-corpus-api-and-mcp-contract.md` (a stale revision-2 copy,
  plus an index row mapping 0001 to the corpus ADR). Merging both would land two
  files numbered 0001 and two copies of this decision at different revisions.
  Condition 19 resolves it: PR #7 deletes its copy and its index row.
- Machine-readable contract: [`src/server/contracts/corpus-v1.ts`](../../src/server/contracts/corpus-v1.ts)
  (this branch carries the pre-condition-16 shape; the two mutually exclusive
  member schemas land on MCAA-260's branch at `3b8f002f`)
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
around that projection. D9 states the rule; conditions 10-19 are what enforce it.

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

Added in revision 3; revised in revision 4 from the MCAA-348 second review, and in
revision 5 to drop `sharedOrigin`. D3
establishes *what content* may cross a tenant boundary; this decides *what else
travels with it*, and where that decision lives.

**The rule.** Every observation a corpus surface returns or renders is projected by
the same function the observation surfaces use, and the projection is decided **per
member row**, against the reader, not per corpus:

> A member row keeps full fidelity only when the reader owns it through their own
> tenant predicate -- the row's own `team_id` **and** `project_id` both match the
> authorized read. Every other row is reduced to published content alone: `id`,
> `kind`, `content`, `shared`, the read-time `position`, and `createdAtEpoch`.
> `team_id`, `project_id`, `metadata` and `serverSessionId` do not cross that
> boundary, in a JSON response or in rendered artifact text, and neither does any
> provenance token (revision 5; see `sharedOrigin` below).

**The reader is an authorization result, not a request field.** Two definitions are
in play in the reviewed implementation and they disagree: `loadMembers()` passes the
*corpus's* project as the reader project, while the id-addressed routes pass
`req.authContext?.projectId ?? ''` -- an empty string for a team-wide key. Neither
is the reader. The reader is: the authenticated `team_id`, plus the project the key
is *authorized for* -- its bound project for a project-scoped key, or the addressed
project once authorized for a team-wide key. One definition, derived once, used by
both the corpus-authorization check and the member projection, which stay separate
decisions: being allowed to open a corpus says nothing about which of its members
you own.

**This was not computable in the reviewed revision.** At `77154737`,
`PostgresCorpusMember` had no `teamId` and `listMembers()` did not
`SELECT observations.team_id`, so the rule could not be evaluated at all and
substituting the corpus's team was the defect rather than a shortcut around it.
Per-member ownership needs that column carried through the member query and type.
As of `3b8f002f` both are in place, and the reader is derived once by
`authorizedReadProject()`; what is still open is the last step -- the serializer
takes a per-corpus `foreign` boolean. Condition 10 records the state at that commit
rather than asserting a "today" that keeps moving.

Four things about the rule are the decision, and each of the first three is a
mistake that was actually made:

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
   requirement rather than a behaviour requirement. Revision 3 said "whichever
   branch merges second owns the convergence", which permits shipping a vulnerable
   surface in the interim. Revision 4 orders it instead: the projection module
   lands first, the corpus work rebases onto it, and the corpus surface is not
   released until the cross-surface tests pass. Revision 4 added that
   `sharedOriginToken` must be exported so condition 12 could import it; revision 5
   withdraws that, because MCAA-346 deletes the helper. The two symbols the corpus
   path imports are `serializeObservationForViewer` and `isOwnerAuthorizedView`,
   both already exported.
4. **Selection is a channel too.** Projecting the response is not enough.
   `buildFilterClauses()` applies `metadataMatch` to foreign shared rows, so a
   caller can filter *other tenants'* rows on a metadata predicate they were never
   shown and read the answer out of `matchedCount`, `observationCount` or plain
   membership -- an oracle over hidden metadata that survives a perfect
   serializer. Private-metadata predicates apply only to owner-authorized rows;
   a filter that would test foreign rows on hidden metadata is rejected rather
   than evaluated, and selection and counting follow the same rule so the two
   cannot disagree. `platformSource` gets the same treatment unless and until it
   is explicitly classified as published information.

**`sharedOrigin` is not in v1, on either surface.** Revisions 3-4 required this
field and revision 4 specified how to build it. Revision 5 withdraws the
requirement, because ADR 0001 (remote client mode and shared scope) had already
decided the opposite for the observation surface and this ADR contradicted it
twenty minutes later. That ADR's condition 1 is resolved *dropped*, its normative
shared view is six fields, and the removal is tracked by MCAA-346. Two live records
cannot give one field opposite fates; the drop is the one that stands.

The drop is also correct on the merits, and revision 4's argument for keeping the
field was a parity argument whose premise the drop removes. Revision 4 justified it
as "the grouping signal the observation surfaces already concede", making a
corpus-side omission a divergence. Search concedes no such signal any more. This is
the same error as D3, one field later: a corpus decision resting on parity with an
observation surface that was being narrowed at the same time. A parity argument does
not hold a boundary when the surface it points at moves -- state the boundary
directly instead.

Directly, then: no consumer reads the token. The only references were the producer,
an optional field on the client type, one README sentence, and the tests pinning it.
It is also the last correlation channel on a projected row, on a projection whose
whole purpose is to publish content *without* provenance -- a reader could otherwise
cluster the shared corpus by publisher and take a census of how many distinct
publishers exist. Linkability is provenance. Boring is a feature: the smaller
surface at a trust boundary is the duller one. Dropping the field also retires the
persisted minting state revision 4's pseudonym would have required, for a field
nobody reads.

**What re-adding costs, stated honestly.** MCAA-346 argues that adding a field later
is "additive and free". That holds for the observation responses and does not hold
here. Every response schema in `corpus-v1.ts` is `.strict()`, and condition 16
requires a test that a projected source carrying a denied field *fails to parse*, so
a consumer pinning v1 rejects a response carrying a key v1 does not list. Re-adding
`sharedOrigin` after release is therefore a breaking change requiring
`corpus-v2.ts`, not an additive one. Reversibility still points to omission, because
the two directions are not symmetric: an absent field costs a version bump whenever
someone wants it, while a shipped correlation channel costs a version bump to
withdraw *and* has been disclosing linkability the entire time. Omit now; if
grouping is ever needed it returns through an amendment that names its consumer, in
`corpus-v2.ts`.

If it does return, revision 4's construction stands as the form -- a persisted
random 128-bit pseudonym per `(team_id, project_id)`, never a truncated digest of
guessable inputs -- and the reason is sharper than revision 4 stated. Revision 4
said the digest fails "once a reader knows or guesses a team", which invites the
reply that `team_id` is an unguessable UUID. The case that matters needs no guessing
at all: `isOwnerAuthorizedView()` deliberately projects a row from the reader's
**own team** in a different project, and a reader knows its own `team_id` because
the owner view returns it. The preimage is then the reader's own team id plus a
project name -- usually a repository or directory -- so a wordlist confirms exactly
which sibling project published the row. That is precisely the boundary D9 point 2
exists to hold. A keyed construction is acceptable only with an explicit key-custody
and rotation design. Whatever the form, such a token is pseudonymity with
deliberate linkability -- never an authorization input, never a uniqueness
guarantee, never described as anonymous.

**Optional is the wrong shape; two schemas is the right one.** Revision 3 accepted
MCAA-260's `projectId`/`metadata` narrowed to `.optional()`. Revision 4 does not.
An optional sensitive field encodes "sometimes sent" and can only be checked by a
test that remembers to assert absence; it cannot fail closed. The owner row and the
projected row are different shapes, so the contract states them as **two mutually
exclusive schemas** -- a projected source that carries `projectId`, `teamId` or
`metadata` at all is a parse error, not a judgment call. `.strict()` then does the
work the review would otherwise have to.

**Corpus-level fields.** The corpus's own `name` and `description` stay -- they are
author-chosen text on a row the author deliberately published, and revision 2
already reasoned that through. `filter` does not: it is build-time configuration,
never published content, and `filter.metadataMatch` carries the literal metadata
keys *and values* the member projection just removed, which makes returning it a
direct contradiction rather than a judgment call. On a non-owner read, `filter` is
omitted from the response and the render's system prompt drops `query`, `kinds` and
`platformSource`.

`filterDigest` does **not** stay, and revision 3's justification for it was wrong.
Calling it opaque confused determinism with confidentiality: `corpusFilterDigest()`
is an unkeyed hash of the whole canonical filter, and a filter is low-entropy
configuration, so the digest is confirmable by guessing. It also does not do the job
revision 3 claimed -- a rebuild over an unchanged filter produces the same digest,
so it never was a rebuild signal. A non-owner read omits it; if a version handle is
genuinely wanted there, it is a server-generated opaque revision id with no
derivation from filter contents.

**Derived values are projected too.** A number computed over unprojected input
carries the input. `stats.tokenEstimate` is the clear case: it is stored at build
time from a render that included every member's metadata, so handing it to a
non-owner leaks a measurement of the text that was withheld. Non-owner statistics
are recomputed from the projected member set. `contentDigest` is acceptable only
when computed over the membership that reader is actually authorized to see.
Observation `id` stays as a citation handle, on the condition that every
dereference of it re-authorizes and that ids remain opaque at the write boundary
(`newId()` is a random UUID, but the repository also accepts caller-supplied ids --
that invariant belongs at the writer, not here). Exact timestamps plus stable ids
permit cross-surface correlation and activity timing; that disclosure is accepted
deliberately and recorded here, rather than justified by parity with search.

**Versioning.** None of this bumps `CORPUS_CONTRACT_VERSION`. `corpus-v1.ts` has not
shipped -- MCAA-259 is still an open PR, there is no released client, so the
"consumer you cannot see and cannot redeploy" does not exist yet. That window is the
entire licence for narrowing required fields to optional, and it closes at the first
release. After that, moving a field out of a response, or into one, is `corpus-v2.ts`.

**Blast radius.** Revision 3 called this "publisher identity, not content". That is
too kind, and the second review was right to reject it. `metadata` is free-form
publisher-controlled JSON: what a generator writes into it is unknown to this
design, and it can carry private information outright. D3 protects the *bodies* of
unshared observations; it says nothing about the confidentiality of metadata
attached to a shared row. So a missed projection discloses publisher identity
**plus arbitrary publisher-attached content of unknown sensitivity**, and the honest
statement is that its severity is bounded by what publishers happen to put in
`metadata` rather than by anything this ADR controls. It travels as far as any
tenant holding a read key, and it is not recoverable once served. The one line D3
still holds is that the *content* of an unshared observation does not cross.

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
   projection, on an ordinary read/write key. Revision 3 called that "publisher
   identity rather than content, so D3 still bounds it"; revision 4 corrected the
   claim in D9 and revision 7 corrects it here. D3 bounds the *bodies* of unshared
   observations and says nothing about free-form `metadata` attached to a shared
   row, so what escapes is publisher identity **plus publisher-attached JSON of
   unknown sensitivity** -- severity bounded by what generators happen to write
   there, not by this design. Every tenant with a read key is in range, and the
   disclosure is not recoverable once served. Condition 10's test -- read the sources
   of *your own* corpus built over shared rows -- is the one that catches it; a
   cross-tenant read test does not.

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

Conditions 10-19 enforce D9. Added in revision 3 from the MCAA-345 review of
MCAA-260; 10, 12 and 13 rewritten and 14-16 added in revision 4 from the MCAA-348
second review; 17 added and the timing corrected in revision 6; 18 and 19 added in
revision 7.

**These are conditions on merging PR #7, not gates on the first release.** Revisions
3-5 wrote "first release", which is one gate too late. The disclosure D9 exists to
close is reachable by an ordinary `memories:read` + `memories:write` caller -- no
`memories:write:shared` grant, no `CLAUDE_MEM_INCLUDE_SHARED` -- because
`memberPredicate`'s `($shared AND observations.shared)` disjunct carries no team
predicate while the ownership test is computed on the container. Build an own-project
corpus with `{ shared: false, filter: { scope: "shared" } }` and every tenant's shared
rows join a corpus you own, so `foreign` is `false` and `serializeSource` returns their
`projectId` and `metadata` whole. Merging that and fixing it before release leaves an
independently vulnerable surface on `main` with only the absence of published shared
rows standing between it and disclosure -- and publishing those rows is exactly what
MCAA-286 turns on. ADR 0001's condition 4 rules the same way from the projection's
side; the two records agree deliberately.

Each clause below says what state it was written against. Where a clause described
the implementation in the present tense, that description is now pinned to a commit
(revision 7): `77154737` for the revision-3/4 reviews, `3b8f002f` for the re-read.
A condition is satisfied when the code satisfies it, never because a sentence
describing the old code went stale.

10. **Decide the projection per member row, against the reader** -- never from a
    per-corpus `foreign` flag. A row is owned only when the row's own `team_id`
    *and* `project_id` match the authorized read (`isOwnerAuthorizedView`). Three
    parts, all required:
    - Carry `observations.team_id` through `listMembers()` and
      `PostgresCorpusMember`; substituting the corpus's team is the defect.
      **Satisfied at `3b8f002f`**: the member type carries `teamId` and the member
      query selects `observations.team_id`. In the reviewed revision neither did,
      so the rule was not evaluable.
    - Derive the reader once -- authenticated team, plus the project the key is
      authorized for (bound project for a project-scoped key; the addressed project
      after authorization for a team-wide key). The reviewed revision held two
      competing definitions: `loadMembers()` used the corpus's project and the id
      routes passed `''` for a team-wide key. **Satisfied at `3b8f002f`** by
      `authorizedReadProject()`, one definition used by both call paths, with corpus
      authorization and member projection still separate decisions. Its `?? ''`
      fallback is acceptable only while `observations.project_id` can never be the
      empty string -- an empty stored `project_id` would make that row owner-visible
      to any team-wide key in the same team. Assert the non-empty invariant at the
      writer or drop the fallback in favour of a predicate that cannot match.
    - Apply the same owner test to the corpus's own `projectId`, so a same-team
      sibling-project read is projected like any other non-owner read. **Open at
      `3b8f002f`**: `serializeSource(member, index, foreign)` still takes a
      per-corpus boolean, which is the defect this condition exists to remove. This
      is the clause condition 12's import closes.

    The test that proves it is not "read another tenant's shared corpus": it is
    **build your own corpus with `scope: 'shared'`, then read its sources**, and
    assert the foreign members come back projected. That path needs no shared-write
    grant.
11. **Project the render, not just the JSON.** `corpus_artifacts` text is a by-value
    copy that `query` feeds to a model, so an unprojected render is the same leak
    one indirection further out. A corpus whose members are not all owner-authorized
    for the reader renders per reader and MUST NOT be read from or written to the
    artifact cache -- the cache key is the membership digest and carries no reader
    dimension, so a cached owner render would otherwise be served verbatim. This
    covers `prime`, `reprime`, `query` and the system prompt, and it holds for an
    **empty member set** too: "every member is owner-authorized" must not pass
    vacuously and hand a non-owner the owner's cached prompt. Keep `prime`/`reprime`
    owner-only so the converse cannot happen either. **The fix is code plus a purge**
    (revision 6): an artifact primed before it lands already holds foreign provenance
    in its text, and the digest cache key cannot tell a projected render from an
    unprojected one, so the code change alone leaves the disclosure sitting in stored
    state. Delete every `corpus_artifacts` row for a corpus whose members are not all
    owner-authorized for its owner, in the same change.
12. **One implementation, projection first.** Import
    `serializeObservationForViewer` and `isOwnerAuthorizedView` from
    `src/server/routes/v1/observation-projection.ts`. Do not re-derive the rule in
    `CorpusService` or `corpus-render`, and do not ship a temporary second
    redaction. Where the corpus row shape differs (it adds `position`, has no
    `serverSessionId`), extend that module -- including its deliberately empty
    `SHARED_METADATA_ALLOWLIST` -- rather than forking it. Sequence: MCAA-281 lands,
    MCAA-346 removes `sharedOriginToken` from that module, MCAA-260 rebases onto
    the result, cross-surface tests pass, then the corpus surface is released.
    Revision 4 also asked for the origin-token helper to be exported and imported;
    revision 5 withdraws that, because condition 15 no longer wants the field and
    MCAA-346 deletes the helper. Do not wait on or re-add it.
13. **Omit `filter` and `filterDigest` on a non-owner read**, and drop `query`,
    `kinds` and `platformSource` from the render's system prompt on the same reads.
    `filter.metadataMatch` carries the exact metadata keys and values the member
    projection removes, so returning it undoes condition 10 in one field;
    `filterDigest` is an unkeyed hash of low-entropy configuration, so it is
    confirmable by guessing and was never the rebuild signal revision 3 claimed it
    was. A version handle for non-owners, if wanted, is a server-generated opaque
    revision id not derived from filter contents.
14. **Close the selection oracle.** Apply `metadataMatch` only to owner-authorized
    rows, or reject a filter that would test foreign rows on a metadata predicate
    the caller cannot see; treat `platformSource` the same way. Selection and
    counting must follow the identical rule, or `matchedCount` /
    `observationCount` / bare membership answer the question the serializer
    refused. The test: changing only hidden metadata on a foreign row must not
    change any value a non-owner can observe.
15. **No `sharedOrigin`, and no other provenance token, on a projected row**
    (revision 5, replacing revision 4's pseudonym requirement -- D9 explains why).
    The projected member set is exactly `id`, `kind`, `content`, `shared`,
    `position`, `createdAtEpoch`; assert it as an exact key set, so a future field
    cannot appear silently. Nothing new is needed in `corpus-v1.ts`, which never
    listed the field. Do not build the pseudonym store revision 4 asked for. If
    grouping is ever wanted it arrives via an ADR amendment naming its consumer, in
    `corpus-v2.ts` -- under `.strict()` it is a breaking addition, not a free one.
16. **Owner and projected rows are two mutually exclusive schemas**, not one schema
    with optional sensitive fields, and the same for derived values: a non-owner
    `tokenEstimate` and the other statistics are recomputed from the projected
    member set rather than reused from the build-time render, and `contentDigest` is
    computed over the membership that reader is authorized to see.
    `tests/contracts/corpus-v1.test.ts` asserts that a projected source carrying
    `projectId`, `teamId` or `metadata` **fails to parse**, so "optional" cannot
    decay into "sometimes sent" and the check fails closed.

    **Satisfied for member rows at `3b8f002f`**, re-read in revision 7:
    `CorpusOwnerSourceSchema` requires `projectId` and `metadata` on a strict shape,
    `CorpusProjectedSourceSchema` is the strict base alone, `CorpusSourceSchema` is
    their union, and `CORPUS_SOURCE_PROVENANCE_FIELDS` denies `teamId` and
    `serverSessionId` on both variants -- neither ever carried them, and denying
    them explicitly stops a later addition passing as additive. The tests cover the
    half-projected row (one provenance field kept), which is the shape a per-corpus
    ownership test produces. That is the right construction, and it is what closes
    the "optional cannot fail closed" finding.
17. **Correct the parity comment in `corpus-v1.ts`** that justifies the member field
    set as "the same rows `POST /v1/search { scope: 'shared' }` would return"
    (revision 6). MCAA-281 made that premise false, and it is the sentence that made
    the defect read as already handled -- three reviewers checked the field set
    against a contract that was itself citing the wrong surface. A stale
    justification is worse than none, because the next reader stops there.
18. **The corpus-level fields need the same treatment as the member rows** -- new in
    revision 7, and the one part of conditions 13 and 16 the contract at `3b8f002f`
    does not yet express. Three concrete gaps, all in `corpus-v1.ts`:
    - `CorpusDetailSchema` requires `filter`. Condition 13 requires `filter` to be
      **omitted** on a non-owner read, so a correct non-owner response cannot be
      represented: either the server violates condition 13 or the response fails its
      own `.strict()` schema.
    - `CorpusSummarySchema` requires `filterDigest`. Condition 13 omits it for the
      same reason, with the same contradiction.
    - `CorpusSummarySchema.projectId` is `z.string().min(1).optional()` with a
      comment that it is omitted when `foreign` is true. That is exactly the
      optional-sensitive-field shape condition 16 rejects one level up, and it is
      keyed to the per-corpus `foreign` flag condition 10 removes.

    Resolve all three the way condition 16 resolved the member rows: an owner detail
    schema and a projected detail schema, mutually exclusive and both `.strict()`,
    with the projected one omitting `projectId`, `filter` and `filterDigest`
    entirely, and a test that a projected corpus carrying any of the three fails to
    parse. Keep `foreign` on the summary -- it is a read-time fact about the corpus
    row, not member provenance -- but it must stop being the input to any projection
    decision. This is a contract-shape gate on the same merge of PR #7 as conditions
    10-17, not a behaviour change: no field gains a new meaning.
19. **One number per ADR, one copy per decision.** This record is ADR 0002 and ADR
    0001 is the remote-client-mode record; see "Numbering, canonical" in the header.
    MCAA-260's branch must delete `docs/adr/0001-remote-corpus-api-and-mcp-contract.md`
    and its `docs/adr/README.md` row, because that path holds a stale revision-2
    copy of this document and claims a number ADR 0001 already owns. Merging PR #4
    and PR #7 as they stand lands two files numbered 0001 and two copies of this
    decision at different revisions -- and a reader who finds the stale copy reads
    conditions 10-19 as though they do not exist, including the merge gate above.
    The ADR is owned by PR #4; PR #7 carries the implementation only.

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

## Second review of D9

MCAA-348, Security & Secrets Engineer: **approve-with-conditions**, five blocking
findings. D9's per-member boundary and the revision-2 retraction were confirmed by
source tracing at `77154737` / `d087e0a2` / `8b045f93`, including the republish
reachability on an ordinary read/write key. Conditions 10-13 were judged *necessary
but not sufficient*. What changed in revision 4:

| Finding | Change |
| --- | --- |
| Reader and denied set both incomplete -- `team_id` not denied; `PostgresCorpusMember` has no `teamId` to compare, so the rule was not evaluable; `loadMembers()` and the id routes hold two competing reader definitions; condition 11 vacuous on an empty member set | `team_id` added to the denied set; D9 gains "the reader is an authorization result" and "this is not computable today"; condition 10 rewritten in three parts; condition 11 covers empty sets |
| Metadata inference survives a correct serializer -- `metadataMatch` filters foreign rows on unseen predicates and the answer reads out of counts; `filterDigest` is an unkeyed hash of low-entropy config, and never was a rebuild signal | New D9 point 4 and new condition 14 (selection and counting follow the response rule); condition 13 now omits `filterDigest` too, with revision 3's "it is opaque" retracted |
| `sharedOrigin` treats a UUID as a secret; 64-bit truncated digest over guessable `project_id` | D9 replaces the construction with a persisted random 128-bit per-`(team, project)` pseudonym; new condition 15. **Superseded by revision 5:** the field is dropped entirely, so no construction ships. |
| Derived values carry unprojected input -- `tokenEstimate` reuses a build-time render that included private metadata | D9 gains "derived values are projected too"; folded into condition 16, with the `id`-as-citation and timestamp-correlation disclosures stated explicitly instead of resting on parity with search |
| `sharedOriginToken` is module-private so condition 12's import is impossible; "whichever merges second" permits an interim vulnerable surface; optional sensitive fields cannot fail closed | Condition 12 orders the landing (MCAA-281 first, corpus rebases, then release) and requires the export; condition 16 replaces optional fields with two mutually exclusive schemas and a test that a projected row carrying a denied field fails to parse. **Superseded in part by revision 5:** the export requirement is withdrawn with the field; the landing order stands, with MCAA-346 inserted. |

The blast-radius claim "publisher identity, not content" was rejected as too kind
and is rewritten: `metadata` is free-form publisher JSON of unknown sensitivity, so
severity is bounded by what publishers put there, not by this design. The decision
to keep `CORPUS_CONTRACT_VERSION = 1` was accepted as consistent with D8 while the
contract is genuinely unreleased, conditional on every prerelease consumer being
updated before first release. No deployed exposure was established by either
review; both are source-level.

## Revision 5 -- reconciling `sharedOrigin` with ADR 0001

Not a review finding. A contradiction between two records, both mine, on the same
day:

| Record | Says about `sharedOrigin` |
| --- | --- |
| ADR 0001, remote client mode and shared scope, condition 1 (PR #6) | Resolved *dropped*. No consumer, last correlation channel on a projected row. Normative shared view is six fields. Removal is MCAA-346. |
| This ADR, revisions 3-4, D9 and condition 15 (PR #4) | Required, and "cannot be deferred"; revision 4 specified a persisted random 128-bit pseudonym. |

Both were unmerged and both were live instructions to the same implementing
engineer, who owns MCAA-346 (delete the field) and MCAA-260 (import the helper that
produces it). Revision 5 resolves it in favour of the drop, on the reasoning in D9
above, and corrects MCAA-346's "additive and free" in the same place: under
`.strict()` schemas, re-adding the field later is breaking, so the omission is
deliberate and permanent until an amendment names a consumer.

Three process notes, because the mechanism matters more than this field:

1. **The cause was a parity argument.** D3 was retracted in revision 3 for resting
   on "the same rows a shared search would return" while MCAA-281 was narrowing
   exactly that. Condition 15 then rested on "the grouping signal the observation
   surfaces already concede" while MCAA-346 was removing exactly that. The same
   error twice in one ADR is a pattern, not an accident: **a cross-surface claim
   about a surface under concurrent change is not a justification.** State the
   boundary this ADR wants, and cite the other surface only for divergence, never
   for permission.
2. **Conditions on another surface's code need that surface's owner.** Revision 4's
   condition 15 required a change inside MCAA-281's module and condition 12 required
   an export from it. Neither was carried to an issue owned by whoever lands that
   module. Cross-record conditions get an issue or they are not conditions.
3. **Numbering.** This ADR and the remote-client-mode ADR were both authored as
   `0001` on separate unmerged branches, so merging both would land two `0001`
   records. Renumbered here to `0002`; the client-mode ADR keeps `0001` as the
   earlier decision. The index links it before PR #6 merges, so that row is dead
   until then.

## Revision 6 -- the conditions were one gate too late

Not a new finding. A timing disagreement between this record and ADR 0001, both mine,
which revision 5's own process note predicted would keep happening.

The Workflow & Eventing Engineer took the D9 divergence from "two implementations of
one rule, reconcile before release" to a reachable disclosure, by naming the part both
earlier reviews had described but not connected: `foreign` is computed on the
*container*, and the container's build predicate deliberately admits other tenants'
rows. So the leak does not need a foreign corpus, a curator key, or a widened read --
it needs an own-project corpus built with `filter.scope = 'shared'`, which any
read/write key can create. I confirmed every step at `d087e0a2` before ruling. The
MCAA-348 second review reached the same reachability independently; three records now
agree.

What that changes is *when*, not *what*. Conditions 10-16 were already the right
conditions; calling them first-release gates would have let the vulnerable surface onto
`main` on the strength of a data precondition that MCAA-286 exists to remove. They are
merge conditions on PR #7 now, in both records.

Two things the earlier revisions genuinely missed, rather than mistimed:

- **The leak is stored, not just returned.** `redactProvenance` is false for an
  own-team corpus, `renderMember` emits metadata *values*, and that render is persisted.
  Condition 11 guarded the cache from serving an owner's render to a non-owner -- the
  reverse direction from the one that is open. Remediation is code plus a purge.
- **The contract was citing the surface that changed.** `corpus-v1.ts` justifies its
  member field set as parity with a shared search, which MCAA-281 falsified. Revision 3
  retracted the same parity argument in D3 and revision 5 named it a pattern; the
  comment in the code was never corrected. Condition 17 does that, because the
  justification is what the next reviewer reads before the field list.

Process note, third instance of the same mechanism: **the record that states a
boundary must also state when it binds.** "Before release" and "before merge" are
different instructions to the same engineer, and the weaker one wins by default if two
records disagree.

## Revision 7 -- conditions re-read against the implementation

MCAA-354, raised by the implementing engineer on MCAA-260. Not a review finding and
not a new decision: no boundary moves, no field changes side, `CORPUS_CONTRACT_VERSION`
stays at 1. Four things were asked for and all four are here.

| Asked | Answer in this revision |
| --- | --- |
| Reconcile D9 with the deletion of `sharedOrigin` | Already done in revision 5, independently and on the same reasoning. D9's "`sharedOrigin` is not in v1, on either surface" and condition 15 stand, and the requested statement is explicit: **a projected corpus member carries no origin token.** Revision 4's pseudonym is withdrawn, not deferred -- do not build the minting store. Condition 12 keeps the landing order with MCAA-346 inserted, and imports only `serializeObservationForViewer` and `isOwnerAuthorizedView`. |
| Re-read condition 10 against `3b8f002f` before re-publishing | Done, clause by clause. Two of condition 10's three parts are now satisfied: `PostgresCorpusMember.teamId` plus `SELECT observations.team_id`, and one reader derived by `authorizedReadProject()` for both call paths. The third is open -- `serializeSource()` still takes a per-corpus `foreign` boolean. Condition 16 is satisfied for member rows: two mutually exclusive strict schemas, `CORPUS_SOURCE_PROVENANCE_FIELDS` denying `teamId` and `serverSessionId` on both, and a half-projected-row test. New condition 18 records what the re-read found still open at the corpus level. |
| Blast radius must not read as identity-only | D9's paragraph was already corrected in revision 4; the duplicate claim in "Blast radius if this fails" item 3 was not, and is corrected here. Both now say the same thing: publisher identity plus publisher-attached JSON of unknown sensitivity. |
| Pin the ADR numbering | Header now states the canonical numbering, names both stale citations and which one still resolves, and condition 19 requires PR #7 to delete its stale `0001-remote-corpus-api-and-mcp-contract.md` copy and index row. |

The re-read also produced the one finding this revision adds. Condition 16 fixed the
optional-sensitive-field shape on **member rows** and left it standing one level up:
at `3b8f002f`, `CorpusDetailSchema` still requires `filter`, `CorpusSummarySchema`
still requires `filterDigest`, and `CorpusSummarySchema.projectId` is still an
optional field keyed to the per-corpus `foreign` flag. Condition 13 says all three are
omitted on a non-owner read, so as written the contract cannot represent a
condition-13-compliant response. Condition 18 resolves it with the same two-schema
construction, on the same merge gate revision 6 set for conditions 10-17, and it is
stated as a condition rather than left for the next reviewer to rediscover -- the same
failure mode process note 2 named: a condition that lives only in a review comment is
not a condition.

Revision 6 landed while this re-read was in progress and moved the whole set from a
first-release gate to a merge gate on PR #7. That ruling stands and it strengthens
this one: conditions 18 and 19 bind at the same merge, and condition 17's stale parity
comment is the same defect class as the stale present tense below -- a justification
the reader trusts because nobody re-read it against the code.

Two process notes, both about how this revision was needed at all:

1. **Present tense in a normative document decays into a false statement.** Three of
   condition 10's clauses described the implementation as it stood at `77154737`.
   The engineer fixed two of them, and the ADR then read as though nothing had
   happened -- a reviewer checking the document against the code finds a mismatch and
   cannot tell whether the condition is unmet or the sentence is stale. Every clause
   that describes code now names the commit it describes. State the requirement in
   the present tense and the observation in the past tense, pinned.
2. **A closed issue is not an address.** MCAA-348 assigned the D9 revision on
   MCAA-259, which was already `done`, so the conditions sat where no heartbeat would
   read them. Revision 5's process note 2 said cross-record conditions get an issue;
   the sharper rule is that they get an **open** issue owned by whoever must act.
   MCAA-354 is that issue, created by the engineer rather than by the reviewer or by
   me -- which is the part of the mechanism that should not have to be improvised.
