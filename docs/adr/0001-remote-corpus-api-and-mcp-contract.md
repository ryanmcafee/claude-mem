# ADR 0001 — Remote corpus (knowledge-base) API and MCP contract

- Status: Accepted, pending second review (cross-boundary design by its own author)
- Date: 2026-09-27
- Deciders: Principal Platform Architect
- Second reviewer: Workflow & Eventing Engineer (required before implementation merges)
- Tracking: MCAA-259, parent MCAA-237
- Machine-readable contract: [`src/server/contracts/corpus-v1.ts`](../../src/server/contracts/corpus-v1.ts)
- Compatibility tests: [`tests/contracts/corpus-v1.test.ts`](../../tests/contracts/corpus-v1.test.ts)

## Context

MCAA-237 delivered remote client mode: a Postgres-backed, multi-tenant server
where the API key is the tenant binding, plus a cross-tenant `shared` scope on
observations (`observations.shared`, the `memories:write:shared` grant, and the
`scope: 'project' | 'shared'` read opt-in on `POST /v1/search`, `POST /v1/context`
and the `/v1/mcp` recall tools).

The knowledge-corpus subsystem was the one deliverable it did not cover. Today
that subsystem is entirely worker-local:

- `src/services/worker/knowledge/` — `CorpusStore` writes one
  `<name>.corpus.json` file per corpus into a local directory; `CorpusBuilder`
  queries local SQLite through `SearchOrchestrator` and materialises the matched
  observations *by value* into that file; `KnowledgeAgent.prime()` starts a
  Claude Agent SDK session, stores its `session_id` in the corpus file, and
  `query()` resumes that session.
- `src/services/worker/http/routes/CorpusRoutes.ts` — `POST/GET /api/corpus`,
  `GET/DELETE /api/corpus/:name`, and `POST /api/corpus/:name/{rebuild,prime,query,reprime}`.
- `src/servers/mcp-server.ts` — the stdio tools `build_corpus`, `list_corpora`,
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
corpora filter on `types`, `concepts`, `files` — columns that exist in SQLite.
The Postgres `observations` row is `(id, project_id, team_id, server_session_id,
kind, content, content_search, generation_key, metadata, embedding, shared, …)`.
Concepts and files are not columns there; at best they live inside `metadata`.
A filter ported field-for-field would silently match nothing.

## Decision

### D1 — A corpus is tenant-owned, addressed by `(team, project, name)`

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
  corpus_id TEXT NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (corpus_id, observation_id)
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
```

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

### D2 — Membership is stored by reference, never by value

`corpus_members` holds observation ids. Rendering resolves the rows at
prime/render time and re-applies the same tenant predicate used by
`PostgresObservationRepository.search()`.

This is the single most important departure from the local design, and it buys
three things at once: `DELETE /v1/memories/:id` propagates (via `ON DELETE
CASCADE`), un-sharing an observation propagates, and a read can never return a
row the caller is not currently entitled to — even if it was entitled when the
corpus was built. The cost is that a corpus is no longer a frozen snapshot; a
corpus that loses members reports a lower `observationCount` on its next render.
That is the correct trade: a knowledge base that keeps serving deleted content is
a defect, not a feature.

### D3 — A shared corpus may contain only already-shared observations

A corpus is team-private by default. `shared: true` requires the existing
`memories:write:shared` grant, exactly like an observation.

The obvious naive rule — "a shared corpus exposes its rendered knowledge but not
its sources" — is rejected. It does not hold: `query_corpus` returns model text
derived from the member rows, so a shared corpus over private observations
exfiltrates them anyway, in an unauditable form. Hiding the sources makes that
worse by removing the audit trail, not better.

So the invariant is enforced on the member set instead:

> A corpus with `shared = true` may only have members whose own
> `observations.shared` is `true`.

Enforced server-side at build **and** rebuild, not only at publish. A build that
requests `shared: true` while its filter admits private rows is rejected with
`422 SharedCorpusPrivateMembers` carrying the disqualifying count — it is not
silently filtered down, and it is not silently downgraded to private. Fail loud,
like the rest of remote mode.

With the invariant in place, exposing a foreign shared corpus's sources is safe
by construction: any reader could already fetch those same rows with
`POST /v1/search { "scope": "shared" }`. That collapses two disclosure rules into
one and leaves nothing for a future reader to get subtly wrong.

Consequence to honour later: if an un-share path is ever added to
`POST /v1/memories`, it must re-validate or demote every shared corpus holding
that row. D2 already makes the row vanish from renders; the corpus's `shared`
flag is what would go stale.

### D4 — The primed session becomes a persisted, deterministic artifact

Options considered:

| Option | Verdict |
| --- | --- |
| **(a) Server-side session affinity** — sticky-route queries to the replica holding the SDK session | Rejected. Pushes stickiness into the ingress and Helm contract, loses every primed session on a rolling restart, and makes a replica's memory part of the API's correctness. Fails *idempotent reconciliation*. |
| **(b) Stateless re-prime per query** — resend the whole rendered corpus with every question | Correct and replica-agnostic, but pays the full corpus token cost per question, which is the exact cost a corpus exists to amortise. |
| **(c) Persisted primed artifact** — `prime` materialises a durable, digest-keyed rendering; every query is a stateless read against it | **Chosen.** |

`prime_corpus` no longer opens an AI session. It renders the member set into
`corpus_artifacts` (system prompt, rendered text, token estimate) keyed by
`content_digest` over the ordered member ids and their `updated_at` values.
Priming stops being an LLM operation at all: it is deterministic, cheap, and
repeatable, so priming twice over an unchanged member set yields the same
digest and writes no new row.

`query_corpus` is then a pure read that any replica can serve from Postgres. The
rendered artifact is the stable prompt prefix, so provider prompt caching — not
server affinity — is what makes repeated questions cheap.

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

### D5 — The filter is expressed in terms the server actually has

Local `CorpusFilter` fields map as follows. Anything unsupported is **rejected**
with `400 ValidationError`, never accepted-and-ignored:

| Local field | Remote field | Notes |
| --- | --- | --- |
| `project` | path `:projectId` | Tenant-checked, not a filter. |
| `types` | `kinds?: string[]` | Maps to `observations.kind`. The local nine-value enum does not apply; server `kind` is free-form (`observation`, `manual`, …). |
| `query` | `query?: string` | `content_search @@ websearch_to_tsquery('english', …)`, as `POST /v1/search`. |
| `date_start` / `date_end` | `dateStartEpoch?` / `dateEndEpoch?` | Epoch ms, matching the existing `*AtEpoch` convention on the wire. |
| `limit` | `limit?: number` | Default 500, max 2000 (see below). |
| `concepts` | `metadataMatch?: Record<string, unknown>` | No column exists. JSONB containment against `metadata`. |
| `files` | `metadataMatch?` | Same. |
| — | `platformSource?: string \| null` | New; mirrors `/v1/search`. |
| — | `scope?: 'project' \| 'shared'` | Member-selection scope. Forced to `shared` (shared rows only) when `shared: true`. |

Build is **synchronous**. It is a SQL select plus an insert of member references
and a deterministic render — no model call (D4), so no job queue is warranted.
Instead of an async job, a filter matching more than `maxMembers` (2000) is
rejected with `422 CorpusTooLarge` and the matched count, so the client narrows
rather than the server silently truncating. Not inventing a new job type here is
deliberate; if profiling later shows builds exceeding the request budget, the
existing `observation_generation_jobs` pattern plus `?wait=true` is the
reversible next step.

### D6 — Endpoints, and read vs write

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

Error shapes reuse the existing server vocabulary exactly — `400 {error:
'ValidationError', issues}`, `403 {error: 'Forbidden', message}`, `404 {error:
'NotFound', message}`, `500 {error: 'InternalError', message}` — plus two new
`422 {error, message, …}` codes, `CorpusTooLarge` and
`SharedCorpusPrivateMembers`. A cross-tenant `:name` answers `404`, not `403`,
following the existing `scopeMismatch: 'not-found'` rule so existence is not
disclosed. Every read and write audits through `auditWrite()` with the scope
that was used, like the recall paths.

Delivery and ordering guarantees, stated rather than left to assumption:
build/rebuild/prime/reprime are **idempotent** writes keyed by
`(team_id, project_id, name)` and `filter_digest` / `content_digest`; repeating
one converges instead of duplicating. `query` is a plain **at-most-once**
request/reply with no server-side retry, and answers are model-generated, so a
client retry may legitimately return different text. Members are ordered by
`position` (oldest observation first), which reproduces the local
`orderBy: 'date_asc'` render order.

### D7 — MCP tool names stay identical across local and remote

The `/v1/mcp` surface gains `build_corpus`, `list_corpora`, `get_corpus`,
`prime_corpus`, `query_corpus`, `rebuild_corpus`, `reprime_corpus`,
`delete_corpus` — the *same names* the local stdio server already exposes, even
though the neighbouring remote tools are bare verbs (`search`, `context`,
`recent`). Shared bones beat local naming aesthetics: a skill or prompt that
says "call `prime_corpus`" must work in both modes without a translation table.

`projectId` is **optional** in the tool schema in both modes and resolved from
context (local: cwd project; remote: `CLAUDE_MEM_PROJECT_ID`). A remote call with
neither errors naming the missing variable, consistent with the remote-mode
never-falls-back rule. Keeping it optional is what lets one schema serve both
modes.

The `scope: 'project' | 'shared'` opt-in appears **only where it means
something**: on `build_corpus` (which rows may become members) and on
`list_corpora` (discovery of other tenants' published corpora). It is *not* on
`get_corpus`, `query_corpus`, `prime_corpus`, `rebuild_corpus` or
`reprime_corpus` — those act on one corpus row whose scope was already fixed at
build time, so a `scope` argument there would be inert and misleading. As
elsewhere, an unrecognised scope value narrows to `project` in MCP and `400`s in
REST; neither ever widens a read.

### D8 — Nothing here breaks the local worker API

The local `/api/corpus*` routes, `CorpusFile` shape, and stdio tool behaviour are
unchanged. The remote surface is additive under `/v1`, so no `/v2` and no version
bump. Three compatibility rules keep it that way, and the tests in
`tests/contracts/corpus-v1.test.ts` pin them:

1. **Additive fields only.** Remote responses add `id`, `artifactId`,
   `contentDigest`, `primedAt`, `shared`, `memberScope`; they remove nothing a
   local consumer reads.
2. **`session_id` is nullable, not removed.** Remote `prime`/`query`/`reprime`
   responses return `session_id: null` rather than omitting the field, so a
   client that reads it gets a defined value with an honest meaning: this server
   holds no resumable session. Local keeps returning a real id.
3. **Tool names and required arguments are frozen** by a golden test. Adding an
   optional argument passes; renaming a tool or making an argument required
   fails, which forces the version conversation instead of leaking a break.

The contract itself is versioned in code as `CORPUS_CONTRACT_VERSION = 1` in
`src/server/contracts/corpus-v1.ts`. A future incompatible change adds
`corpus-v2.ts` beside it and keeps v1 serving.

## Consequences

**Good**

- Tenant isolation is structural, not conditional: the composite FK and the
  by-reference membership mean there is no code path that can join a corpus to
  another tenant's rows.
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
- Query cost depends on prompt caching being effective. If the provider cache
  misses, a large corpus query is expensive. The `token_estimate` on the artifact
  is what makes that visible; alerting on it belongs with the SRE &
  Observability Engineer.
- `metadataMatch` is a weaker substitute for local `concepts`/`files` filtering
  and only works if generators actually write those keys into `metadata`. That
  gap is real and belongs on the backlog, not hidden behind an accepted-and-ignored
  parameter.
- `maxMembers = 2000` is a guess. It is a server-side constant precisely so it
  can be raised without a contract change.

**Blast radius if this fails**

A corpus bug is contained to corpus endpoints: observations, ingest, search,
context and recent share no code path with it and keep working. The one genuinely
dangerous failure mode is D3 being implemented at publish time only — that would
turn `memories:write:shared` into a bulk-exfiltration channel for private
observations. That case gets an explicit negative contract test.

## Conditions on the implementing engineer

1. Enforce D3 on build *and* rebuild, with a test proving a rebuild cannot
   smuggle a newly-private row into an already-shared corpus.
2. Never store observation content in `corpora` or `corpus_members` (D2).
3. Route every member read through the same team predicate as
   `PostgresObservationRepository.search()`; do not hand-roll a second one.
4. Fix the remote-mode dead-end: the stdio corpus tools must go through the
   remote client when `CLAUDE_MEM_SERVER_URL` is set, not `callWorker()`.
5. Import the schemas from `src/server/contracts/corpus-v1.ts` rather than
   retyping them, so the compatibility tests actually guard the shipped surface.
6. A cross-tenant `:name` returns `404`, never `403`.
