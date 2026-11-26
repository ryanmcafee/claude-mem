# 0003 -- A client-supplied idempotency key on POST /v1/memories

- Status: accepted (approve-with-conditions; conditions in "Conditions of approval")
- Date: 2026-09-28
- Deciders: Principal Platform Architect (reviewer), Senior Application Engineer (author of the change)
- Implementation: https://github.com/ryanmcafee/claude-mem/pull/13
- Tracking: MCAA-360 (this decision), MCAA-241 (the import path it unblocks)

## Context

Every operator who used claude-mem before the server existed has a local SQLite database under
`~/.claude-mem`. Moving them onto a central Postgres deployment means replaying those rows through
the public write path. An import that cannot be re-run is not usable: it will be interrupted by a
network failure, a partial run, or an operator who simply runs it twice, and the only safe way to
recover today is to purge the project and start over.

So the write path needs a way for a caller to say "this is the row I already told you about". Three
properties matter and are hard to retrofit:

1. **The key must be supplied by the caller.** Every other dedup key in this schema
   (`agent_events.idempotency_key`, `observation_generation_jobs.idempotency_key`,
   `server_sessions.idempotency_key`) is derived *server-side* from the input's natural identity. A
   source SQLite row has no identity the server can reconstruct, so the client has to name it. This
   is the first caller-supplied key in the system, which makes it the first one that crosses a trust
   boundary.
2. **It must be tenant-scoped.** Two operators importing structurally identical local databases must
   not dedup against each other.
3. **It must not break the callers already on this route.** `POST /v1/memories` is the canonical
   write path used by the MCP `observation_add` surface, and there are deployed clients we cannot
   redeploy in step with the server.

The same route serves the homelab install and the commercial deployment, so this cannot be an
import-only side door (lens: **shared bones, not copies**).

## Options considered

### Where the key lives

1. **An `Idempotency-Key` HTTP header.** Rejected. The header has established semantics -- Stripe's
   and the IETF `idempotency-key` draft's -- that this feature deliberately does not implement: the
   header replays the *original response* for a bounded retention window, and fingerprints the
   request so that the same key arriving with a different body is an error. What we want is
   permanent, unbounded, and does not compare bodies at all. Borrowing the header name for different
   semantics would mislead every client author who has seen the header before, and it is the kind of
   mistake that is unfixable once clients depend on it.
2. **A separate `POST /v1/memories:import` surface.** Rejected. A second write path duplicates API
   key authorization, project-ownership assertion, shared-scope handling, session linkage, and audit
   emission. The concern is one optional field, not one new endpoint (lenses: **shared bones, not
   copies**, **boring is a feature**).
3. **Chosen: an optional `idempotencyKey` body field on the existing route.** The key is persisted
   as part of the row and is durable forever, which makes it part of the resource's identity rather
   than a property of the transport. The body is where resource identity belongs.

### What the name should be

1. **`dedupeKey` / `sourceKey`.** Rejected. `idempotencyKey` is already this repository's single word
   for exactly this concept across three tables and their repositories. A second word for one concept
   is the vocabulary form of the same failure the architecture exists to prevent.
2. **Chosen: `idempotencyKey`,** with the divergence from HTTP header semantics stated normatively
   below so no client author has to infer it.

### How the key is stored

1. **A new `client_idempotency_key` column with its own partial unique index.** Rejected as more
   machinery for the same invariant: a migration, a second unique index on a hot write table, and two
   conflict targets to reason about on one INSERT.
2. **Chosen: reuse `observations.generation_key`, namespaced by prefix.** A client key is stored as
   `client:v1:<key>`; the generation pipeline's keys are already
   `generation:v1:<jobId>:<index>:<hash>` (`buildObservationGenerationKey`, the only other writer of
   that column). The prefixes are disjoint, so no string a client can send will ever equal a key the
   pipeline wrote. Uniqueness is the pre-existing
   `idx_observations_generation_key_scope UNIQUE (team_id, project_id, generation_key)`, which
   supplies tenant scoping for free (lenses: **boring is a feature**, **reversibility** -- a prefix is
   a code change, a column split is a migration).

### What a replay returns

1. **`201` on both paths.** Rejected: the caller then cannot distinguish "I imported this" from "this
   was already here", which is the one thing the import needs to report.
2. **`409 Conflict` on replay.** Rejected: a replay is the *expected* outcome of a re-run, not an
   error, and making it an error forces every caller to treat its own success path as a failure.
3. **Chosen: `201` with `created: true` on insert, `200` with `created: false` on replay,** returning
   the stored row unmodified.

## Decision

`POST /v1/memories` accepts an optional `idempotencyKey` string (1..512 characters after trimming).

- **Omitted** -- behaviour is byte-for-byte what it is today: a new row on every call, `201`.
- **Supplied and new for this `(team, project)`** -- the row is inserted, the response is `201` with
  `{ memory, created: true }`, and a `memory.write` audit row is emitted.
- **Supplied and already present for this `(team, project)`** -- nothing is modified. The stored row
  is returned as `200` with `{ memory, created: false }`. `updated_at` is preserved and the stored
  `content` is **not** overwritten, even when the replayed request carries different content.

The key is stored as `client:v1:<trimmed key>` in `observations.generation_key`. `ServerClient`
forwards the field and surfaces `created?: boolean`.

## Guarantees (normative)

- **Delivery guarantee.** The write path is **at-least-once** delivery with **exactly-once effect per
  `(team_id, project_id, idempotencyKey)`**. Without a key it is at-least-once with no dedup, which is
  what it has always been.
- **First write wins.** The key identifies the row, not the request. Content is never compared and
  never updated. A caller that needs the latest content must use `PATCH /v1/memories/:id`.
- **No response replay.** Unlike an HTTP `Idempotency-Key`, the replay returns the *current stored
  row*, not a recording of the original response.
- **No expiry.** The key is durable for the lifetime of the row. There is no retention window after
  which a key is forgotten and a re-import would duplicate.
- **Scope.** Keys are namespaced per `(team_id, project_id)`. Two tenants, or one tenant's two
  projects, may use identical keys without interacting.
- **Status codes.** Clients MUST treat any `2xx` as success and read `created` from the body. The
  status code is informational; `created` is the contract. A client that tests `status === 201` is
  wrong and will report every replay as a failure.
- **Ordering.** None is offered or required. Concurrent writes with the same key resolve to one row
  by the unique index; the loser observes `created: false`.

## Backward compatibility

This is additive and needs no route version. The `200` status is only reachable by a request that
opted in by sending a field that did not previously exist, so no client that predates the change can
observe it. The in-repo client already gates on `response.ok`
(`src/services/hooks/server-client.ts`), so it accepts `200` without modification. `created` is
optional on the response type precisely so that a *new* client talking to an *old* server sees
`undefined` rather than a wrong `false` -- see condition C5.

## Blast radius

- **A replay that is wrongly treated as an insert** (old server, or a client that ignores `created`)
  duplicates rows silently. There is no error to notice. This is why the CLI counts responses with no
  `created` field and warns, rather than assuming.
- **Losing the unique index** `idx_observations_generation_key_scope` turns every re-import into a
  full duplication with no error raised. The index is part of this contract, not an optimization.
- **Bumping `IMPORT_KEY_VERSION` or the `client:v1:` prefix** re-imports every row under fresh keys,
  duplicating the entire corpus. Both constants are effectively permanent.
- **Failure is confined to one `(team, project)`.** A malformed or colliding key cannot affect another
  tenant, because the uniqueness scope includes `team_id`.
- **Tuple churn.** `ON CONFLICT ... DO UPDATE SET updated_at = observations.updated_at` writes a new
  tuple version on every replay even though no column changes, so a large repeated import leaves dead
  tuples proportional to rows scanned and depends on autovacuum to reclaim them. Accepted: the
  alternative (`DO NOTHING` plus a follow-up `SELECT`) costs a second round trip per row and a second
  code path. `observations` has no triggers and `content_search` is a `GENERATED ... STORED` column
  recomputed to the same value, so the rewrite is inert as far as row content is concerned.

## Trust boundaries

The new boundary is that **an API key holder now chooses a primary-key-like value**. Three things
contain it:

1. **The `client:v1:` prefix** means a client cannot address, alias, or hijack a row written by the
   generation pipeline.
2. **`team_id` in the uniqueness scope** means a client cannot address another tenant's row.
3. **`assertProjectOwnership`** already runs before the insert, so the `(team, project)` pair is
   authorized, not asserted by the caller.

What remains, and is accepted: within its own team and project, a caller that guesses a key learns
that a row exists and receives its content. Keys are caller-chosen and in practice high-entropy
(the import uses a SHA-256 fingerprint), the disclosure stays inside the tenant, and any API key with
write scope on that project could read the row anyway. Condition C4 makes the probing visible.

## Conditions of approval

These are normative. The decision is accepted subject to them.

**C1 -- Validate before normalizing.** `z.string().min(1).max(512)` accepts `"  "`, and
`buildClientIdempotencyKey` then trims it to an empty suffix. Every whitespace-only key therefore
collapses to the single key `client:v1:`, and `"x"` and `" x"` collide. Validate the trimmed value at
the route boundary (`z.string().trim().min(1).max(512)`) and remove the `.trim()` from
`buildClientIdempotencyKey`, so exactly one place owns normalization. Add a case pinning that a
whitespace-only key is rejected with `400`, not silently coerced.

**C2 -- State the guarantees on the route.** The "Guarantees (normative)" section above is the
contract. The `200`/`201` split, "first write wins, content is never compared", "no expiry", and
"read `created`, not the status code" must be reachable from `docs/api.md` for the
`POST /v1/memories` entry. A guarantee only this ADR knows is not a contract a client author can
follow.

**C3 -- Say that `idempotencyKey` is not an HTTP `Idempotency-Key`.** Wherever the field is
documented, name the two differences explicitly: no request fingerprinting (a different body with the
same key is accepted and ignored, not rejected) and no retention window. Client authors arrive with
the header's semantics already in mind.

**C4 -- Audit the replay under a distinct action.** Not emitting `memory.write` on a replay is
correct: nothing was written, and a `memory.write` row for a no-op would make the audit log lie. But
silence is indistinguishable from a dropped audit write. Emit `memory.write.duplicate` on the `200`
path, against the existing observation id. `audit_log.action` is plain `TEXT` with no `CHECK`
constraint, so this needs no migration, and it is what makes key-probing detectable.

**C5 -- Keep `created` optional on the wire type and never coerce it to `false`.** `created?: boolean`
correctly models a server that predates this change, and `src/cli/import-command.ts` already does the
right thing: a missing `created` counts as created and increments `responsesWithoutCreatedFlag`, which
is warned at the end of the run. Do not "clean this up" into a required field or a
`created ?? false` default -- that would silently report a duplicating import as a clean one. Any
future SDK in another language inherits this rule.

**C6 -- Say that the import adds, it does not sync.** `buildImportIdempotencyKey` derives the key
from `(table, sessionId, rowId)` and deliberately excludes content, so a source row edited after its
first import re-imports as already-present and the central copy keeps the older text. For an
append-only observation log this is the right choice, but `created: false` means "a row with this key
exists", not "the same content is present". State it in `docs/migration-worker-to-server.md`, and have
the CLI summary say `already present (content not compared)` rather than a bare count.

## Explicitly rejected, so it is not relitigated

- **Request fingerprinting with `409`/`422` on mismatch.** It needs a content hash on the row or a
  comparison read on every write, and the import's keys are stable by construction. Revisit only if a
  caller appears whose keys are not derived deterministically.
- **A route version bump.** No consumer can observe the change without opting into it.
- **Splitting `generation_key` into two columns.** Deferred until a second caller-supplied key kind
  exists; the `client:v1:` prefix is the cheap, reversible form of the same isolation.

## Consequences

- The SQLite import becomes safely re-runnable, and a partial run is recovered by running it again.
- Any future caller that can name its own rows (a second importer, a bulk backfill, an operator
  replaying a queue) gets idempotency for free on the same route, with no new surface.
- `observations.generation_key` is now a shared namespace with two documented prefixes. A third writer
  must claim its own prefix, and this ADR is where the prefixes are enumerated.
- The tenant-scoped unique index is now part of the public contract. Changing or dropping it is a
  breaking change to `POST /v1/memories`, not an internal storage decision.
- `created` becomes a field every memory-write client is expected to read. Clients that ignore it keep
  working but lose the ability to report imported-versus-present.

## Compatibility tests

- `tests/server/runtime/memories-idempotency-routes.test.ts` (Postgres-gated) pins: first write is
  `201` + `created: true`; the replay is `200` + `created: false` returning the same id with the row
  count unchanged; `updated_at` and `content` survive the replay; a replay carrying *different*
  content does not overwrite the stored body; a different key is a different row; **a request with no
  key behaves exactly as before** (two `201`s, two rows) -- this is the backward-compatibility pin;
  two tenants using the same key each get their own row; a client key cannot alias a row the
  generation pipeline wrote.
- `tests/import/sqlite-import.test.ts` covers the import's key derivation and its
  created/already-present accounting.
- CI job `import-and-backup (postgres)` runs both, and per ADR 0001's gating rule a silently skipped
  Postgres suite fails the build.
- Still owed by C1: a case rejecting a whitespace-only key. Still owed by C4: a case asserting the
  replay emits `memory.write.duplicate` and no `memory.write`.
