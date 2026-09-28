# 0001 -- Remote client mode, API-key tenant binding, and an opt-in shared scope

- Status: accepted (approve-with-conditions; conditions in "Conditions of approval")
- Date: 2026-09-27
- Deciders: Principal Platform Architect (reviewer), Senior Application Engineer (author of the change)
- Implementation: https://github.com/ryanmcafee/claude-mem/pull/3
- Tracking: MCAA-237 (this decision), MCAA-259 / MCAA-260 (corpus operations, out of scope here)

## Context

claude-mem was built as a single-operator tool: a Claude Code plugin spawns a local worker and
writes observations into SQLite under `~/.claude-mem`. We now need the same memory to serve
agents that run in containers -- Kubernetes pods from the Helm chart, and hosted agents that
never run the Claude Code plugin at all. Those agents belong to different tenants and must not
be able to read each other's memory.

Three properties were missing and are hard to retrofit later:

1. **A client mode with no local store.** The pre-existing `CLAUDE_MEM_RUNTIME=server` runtime
   degrades to the local worker when its configuration is incomplete. On a pod that means memory
   is written to a SQLite file in an ephemeral filesystem that nothing ever reads, and the
   failure is invisible until someone notices the memory is empty.
2. **Server-side tenant isolation.** A read filter applied by the client is not isolation. The
   server has to be the thing that decides which rows a caller can see, from a credential the
   caller cannot forge.
3. **A way to share knowledge across tenants on purpose.** Some knowledge is worth publishing to
   every tenant (golden paths, platform runbooks). Without an explicit scope, teams either get no
   sharing or get accidental sharing; both are wrong.

The same code serves the homelab install and the commercial deployment, so this cannot be a
deployment-specific branch of the storage layer (lens: **shared bones, not copies**).

## Options considered

### Trigger for remote mode

1. **Treat any configured server URL as remote mode.** Rejected: the legacy server runtime keeps
   its address under the same `settings.json` key and is specified to fall back to the worker, so
   this would convert every installed server-runtime settings file into a hard startup error.
   This regression was actually written, caught by the pre-existing `runtime-selector` tests, and
   reverted in `cda57815` -- it is recorded here because the trap is not obvious from the key name.
2. **Require `CLAUDE_MEM_RUNTIME=remote` always.** Rejected as the sole trigger: a chart that sets
   only `CLAUDE_MEM_SERVER_URL` would silently write to a local database, which is precisely the
   failure this mode exists to prevent.
3. **Chosen: an environment `CLAUDE_MEM_SERVER_URL` triggers on its own, and
   `CLAUDE_MEM_RUNTIME=remote` triggers from either the environment or `settings.json`. A server
   URL found only in `settings.json` does not trigger it.** The container path (env vars) fails
   loudly; the interactive install path keeps its documented fallback behaviour.

### Tenant isolation

1. **Client-supplied tenant id.** Rejected outright: the client is outside the trust boundary, so
   a forged or omitted id is an isolation bypass by construction.
2. **Postgres row-level security with a per-request role.** Rejected for now: stronger in
   principle, but it moves the authorization decision into session state that every query path
   (pool checkout, transactions, background jobs) has to set correctly, and getting one path wrong
   fails open. Revisit if we add SQL surfaces outside the repository layer (lens: **boring is a
   feature**; **reversibility** -- this stays open as a later hardening step).
3. **Chosen: the API key is the tenant binding.** The server resolves `teamId` from the
   authenticated key and passes it to every repository call; `projectId` from the request body is
   additionally checked against the key's project scope. A forged `projectId` returns nothing
   because the team predicate still applies.

### Cross-tenant sharing

1. **A separate "global" project every tenant can write to.** Rejected: it needs its own
   ownership, quota and delete semantics, and a row would have to be copied to be shared, so the
   original and the copy drift.
2. **A separate publish endpoint.** Rejected: publishing then duplicates the whole write surface
   (session linking, metadata, generation keys) for one boolean's difference, and the two paths
   would drift. See "Consequences" for how the grant is enforced instead.
3. **Chosen: `observations.shared` boolean plus an opt-in read scope.** Writing it requires an
   extra key scope; reading it requires naming `scope: "shared"` on the query.

## Decision

1. **Remote client mode never falls back.** When remote mode is requested and the configuration is
   incomplete, resolution throws `RemoteModeConfigError` naming the missing variable. No worker is
   spawned and no local memory database is opened; `openConfiguredSqliteDatabase` asserts this, so
   the guarantee does not depend on every caller remembering it.
2. **The API key is the tenant binding.** Isolation is enforced server-side in the repository
   layer, not by the client and not by request fields.
3. **Cross-tenant reads are opt-in per query and fail closed.** `scope` is optional on
   `POST /v1/search`, `POST /v1/context` and the `/v1/mcp` tools `search` / `context` / `recent`.
   Omitted means `project`. An unrecognised value is a `400` on REST and narrows to the caller's
   own tenant on MCP. Neither surface widens a read on bad input.
4. **Publishing to the shared scope is a separate grant, not a separate endpoint.** `shared: true`
   on `POST /v1/memories` requires `memories:write:shared` on the key; a key holding only
   `memories:write` gets `403`. It is never downgraded to a silent team-private write, because a
   curator who believes they published and did not is worse than a failed request.
5. **The schema change is additive.** `observations.shared BOOLEAN NOT NULL DEFAULT false` with a
   partial index, applied as idempotent DDL in the existing bootstrap. No version bump on the API:
   every new field is optional on request and additive on response, so an un-redeployed consumer
   keeps its exact current behaviour (lens: **backward compatibility by default**,
   **schema evolution**).
6. **`shared` is returned on every serialized observation, unconditionally.** A consumer holding a
   row needs to know whether it came from another tenant; a field that appears only sometimes makes
   its absence ambiguous and pushes the inference onto the reader.

## Guarantees

- **Reads and writes are request/reply over HTTP and synchronous.** `POST /v1/memories` returns
  after the row is committed, so a caller can read its own write immediately.
- **`POST /v1/events` is at-least-once into the observation generation queue.** The event row is
  committed synchronously; the derived observations appear later. A client that retries an event
  may enqueue generation twice -- the `(team_id, project_id, generation_key)` conflict clause is
  what keeps that from producing duplicate observations. Read-after-write of *derived* memory is
  eventually consistent, and nothing in this contract promises otherwise.
- **Ordering is not promised across requests.** Search results are ranked by text relevance then
  `updated_at`; `recent` is ordered by `created_at DESC`. There is no cross-client ordering
  guarantee, and none is needed by any consumer in this contract.
- **A derived observation is never published.** Publishing is an explicit act on the write path:
  only `POST /v1/memories` can set `shared`, and only behind the scope check. The generator's
  `obsRepo.create` call in `processGeneratedResponse.ts` passes no `shared` field at all, so the
  column default applies and a generated row is private by construction -- whatever the provider
  returned, and whatever the event's session metadata claimed. The `observation.created` audit
  entry records `shared` from the persisted row rather than from that input, so the audit log
  reflects what landed. A caller cannot widen a derived row by sending shared-looking input to
  `POST /v1/events`.

## Blast radius

- **Wrong tenant predicate.** Worst case in this design: one tenant reads another's private
  memory. This is the reason the predicate lives in one place (`PostgresObservationRepository`) and
  is pinned by `tests/server/runtime/tenant-isolation-routes.test.ts`, including the negative cases
  of an omitted and a forged scope.
- **Server unreachable in remote mode.** Hooks error instead of writing locally. Agents lose memory
  capture for the outage window and say so; they do not silently accumulate a second store. This is
  the deliberate trade: visible failure over invisible divergence.
- **Rollback.** `SHARED_SCOPE_DOWN_SQL` drops the index and the column. That direction is safe:
  after the rollback nothing is shared and every query means what it meant before. Re-running the
  bootstrap re-adds the column with its `false` default, so published state is lost rather than
  restored -- a republish, not a data-loss event, because the observation rows themselves survive.

## Trust boundaries

1. **Client to server.** Everything in the request body is untrusted. `teamId` is never read from
   it; `projectId` is validated against the key's scope; `scope` is parsed into a closed enum.
2. **Tenant to tenant, across the shared scope.** This boundary is new, and it is the one place in
   the design where a row deliberately crosses. Two properties hold: reads require the opt-in, and
   writes require the extra grant. A third property is pinned by test rather than assumed -- a
   shared row is readable by another tenant but not deletable by it (`DELETE` as a non-owner
   returns `404` and the row survives), so visibility never implies mutability.
3. **Curator key to every tenant.** A key with `memories:write:shared` can publish to everyone. It
   is a distinct key class on purpose; see the conditions.

## Conditions of approval

These were raised in the design review of PR #3 and are the conditions attached to the approval.
They do not change the API surface approved above.

1. **Cross-tenant rows disclose the publisher's identifiers.** *(Superseded by the MCAA-283
   security review; resolved by PR #8 -- see "The shared-row response shape" below.)* A shared row
   serialized to a non-owning tenant carried the owner's `projectId`, `serverSessionId`, `teamId`
   and `metadata`. `projects.id` is a caller-supplied string, in practice a repository or directory
   name, and the write path injects the publisher's `metadata.agentId`, so publishing a runbook also
   published the project it came from and the agent that wrote it. Dropping two fields was found
   insufficient: the requirement became a single allowlisted projection shared by REST and MCP, with
   `metadata` omitted wholesale. Resolved.
2. **Publishing must be auditable.** *(Resolved by PR #8.)* The observation-create audit entry did
   not record whether the write was a shared publish. `shared` is now carried on both `memory.write`
   and `observation.created` audit details -- sourced from the persisted row rather than the request
   body, so it reflects what actually landed after the scope check -- making "who published what to
   every tenant" answerable from the audit log alone.
3. **The chart must not mint wildcard keys for agents.** `ensureSharedWriteAllowed` accepts the `*`
   scope, so a wildcard key can publish. Agent keys get `["memories:read","memories:write"]`; only
   the curator key adds `memories:write:shared`.
4. **The shared scope is server-global, not per-project.** With `scope: "shared"` the project
   predicate does not constrain the shared branch of the query, so a project-scoped key also sees
   shared rows published from outside its project scope -- including its own team's other projects.
   That is intended, but it is surprising enough that it must be stated in the operator-facing
   contract rather than inferred from the SQL.
5. **`CLAUDE_MEM_INCLUDE_SHARED` widens reads for an entire pod, not one query.** It must stay off
   by default in the chart's values, and the value that turns it on belongs in a reviewed manifest.

## The shared-row response shape (normative)

Every observation leaving `/v1/search`, `/v1/context` and the three MCP recall tools is serialized
by one function -- `serializeObservationForViewer` in
`src/server/routes/v1/observation-projection.ts`. Centralizing it is part of the decision, not an
implementation detail: a per-route filter leaks from whichever surface someone forgets to update.

The ownership test is the query's own tenant predicate:

```
full fidelity  iff  row.teamId === viewer.teamId && row.projectId === viewer.projectId
```

The viewer is the team the API key is bound to and the project the caller asked for. It is never
read off the row, so a forged field in a request body or MCP argument cannot promote a caller to
the owner view. Everything else in a result set arrived through the shared branch of the predicate
-- a foreign tenant, or the caller's own team in a project outside the query -- and gets the shared
view. One rule covers both, so there is no second path to forget.

**Owner view** (unchanged from the shape approved in PR #3): `id`, `projectId`, `teamId`,
`serverSessionId`, `kind`, `content`, `metadata`, `shared`, `createdAtEpoch`, `updatedAtEpoch`.

**Shared view**: `id`, `kind`, `content`, `shared`, `createdAtEpoch`, `updatedAtEpoch`. `teamId`,
`projectId`, `serverSessionId` and `metadata` are omitted. A shared row carries no publisher
provenance of any kind, pseudonymized or otherwise.

- `metadata` is omitted **wholesale**, not filtered. Every key on a published row is
  publisher-controlled free-form JSON, the write path injects the publisher's `metadata.agentId`,
  and nested objects can repeat the same identifiers. `SHARED_METADATA_ALLOWLIST` is a named,
  deliberately empty constant so that admitting a key is a reviewed edit rather than an oversight.
- `id` is safe to emit: it is a server-generated `randomUUID()`, and the HTTP write path never
  passes a caller-supplied id to the repository, so it carries no provenance. It is also the handle
  a consumer needs for dedup, and owning it does not grant mutation -- cross-tenant delete by id is
  still rejected.
- **No origin token.** PR #8 emitted `sharedOrigin`, the first 16 hex characters of
  `sha256("claude-mem:shared-origin:v1:<teamId>:<projectId>")` -- stable per publisher so results
  could be grouped, and non-invertible because `teamId` is a 122-bit random UUID. Condition 1 below
  reserved the decision on whether to keep it. **Decided: dropped.** No consumer reads it -- the
  field's only references were the projection, an optional client type, one README sentence and the
  tests pinning it -- and it was the last correlation channel left on a projected row: it lets any
  authenticated tenant cluster the shared corpus by publisher and count distinct publishers. That is
  provenance, which is the thing this projection exists to withhold. Adding the field back later is
  additive and free if a real consumer names the need; removing it after enablement would need a
  version and a migration path (lenses: **reversibility**, **trust boundaries**, **boring is a
  feature**). The removal is tracked as MCAA-346 and lands before the enablement gate; until it
  does, the shipped code still emits the field and this section is the normative target, not a
  description of `main`.
- `/v1/context` packs its context string from the projected rows, so the prose blob cannot carry a
  field the `observations` array dropped.

`GET /v1/events/:id/observations` is deliberately outside this projection. Its SQL binds both
`o.team_id` and `o.project_id` to the authorized event's own scope, so every row it can return
already satisfies the ownership test by construction; it has no shared branch to redact.

### Every surface that can return an observation body cross-tenant goes through this function

The scope of the rule is the trust boundary, not the route list. Any new surface that can hand a
caller the content of a row it does not own -- a search, a bundle, a rendered prompt, a cache entry
-- serializes through `serializeObservationForViewer` or is recorded here as an exception with the
reason its SQL makes the shared branch unreachable.

This is not hypothetical. The corpus surface (MCAA-260, PR #7) is a second read path over the same
rows: `?include=sources` returns member bodies, and `query_corpus` renders every member into the
text a foreign reader is answered from. Its author found and fixed the cross-tenant *container*
case, including the non-obvious one -- the render cache is keyed on the membership digest with no
viewer dimension, so an owner's primed render would have been served verbatim to another tenant.

**Revised 2026-09-28: that redaction is applied to the wrong subject, and the resulting disclosure
is reachable.** Two independent reviews reached the same conclusion from source -- the Workflow &
Eventing Engineer's trace on MCAA-281 and the second security review on MCAA-348 -- and I confirmed
every step below by reading `d087e0a2`. The ownership test is computed on the container, then applied
to rows the container's own build predicate deliberately admitted from other tenants:

```
foreign  =  corpus.teamId !== caller.teamId          CorpusService.ts:341, :405, :503
breadth  =  ((observations.project_id = $p AND observations.team_id = $t)
             OR ($shared AND observations.shared))   corpora.ts:186-187   <- no team predicate
```

So an ordinary `memories:read` + `memories:write` caller -- no `memories:write:shared`, no
`CLAUDE_MEM_INCLUDE_SHARED` -- builds a corpus in **its own** project with
`{ shared: false, filter: { scope: "shared" } }`. `breadth` is `'shared'` independently of
`request.shared`, and the `shared && privateMemberCount > 0` guard constrains *publishing*, not
member breadth, so nothing rejects it. The member set now holds every tenant's shared rows while the
`corpora` row is the caller's, `foreign` is therefore `false`, and
`serializeSource(member, i, false)` spreads `{ projectId, metadata }` for every member --
handing the caller another tenant's project id and the `metadata.agentId` the write path injected.
`listMembers` re-applies `OR observations.shared` unconditionally, so the rows are still there at
read time.

The answer path carries the same defect and **persists** it: `redactProvenance: foreign` is false,
`renderMember` emits metadata values (not just keys) into the text `query_corpus` answers from, and
because `foreign` is false that render is written to `corpus_artifacts`. The cache fix closed the
opposite direction -- an owner's render served *to* a foreign reader -- not a foreign member's
provenance entering an owner's render. Remediation is therefore code **plus** a purge of
already-primed artifacts.

No cross-tenant shared row exists yet, so there is nothing to leak today -- see "The precondition
that holds the door shut" below for what that claim actually rests on, which is narrower than a
reading of the chart templates. This is a design defect with no live exposure, and the reason it is
still merge-blocking is that the data precondition is exactly what MCAA-286 turns on. The contract's
own justification for the field set --
"the same rows `POST /v1/search { scope: 'shared' }` would return", `corpus-v1.ts` -- is now false
and must be corrected with the code.

Root cause: this is a **second implementation of one rule**, and the two implementations disagree in
both shape and subject.

- **Denylist vs allowlist.** `serializeSource` spreads `foreign ? {} : { projectId, metadata }` --
  it names what to withhold. The projection names what to emit, against a deliberately empty
  `SHARED_METADATA_ALLOWLIST`. Add a column to `observations` tomorrow and the search path keeps it
  private by default while the corpus path publishes it by default.
- **The subject of the test.** The corpus path tests who owns the *corpus*; the projection tests the
  *row* -- team **and** project, because a same-team row outside the queried project also arrived
  through the shared branch. Only the row-level test is sound for a mixed-provenance member set.

## The precondition that holds the door shut (stated exactly)

Both the corpus finding above and the ratification below rest on "no cross-tenant shared row exists
yet." Earlier revisions of this record stated that as *no manifest mints a `memories:write:shared`
key*. That is necessary but not sufficient, and it points a reader at the wrong check:
`ensureSharedWriteAllowed` returns true for **either** `memories:write:shared` **or** a bare `*`
(`ServerV1PostgresRoutes.ts:1340`), so a wildcard key issued for some unrelated reason can publish
`shared: true` today with no curator key in existence anywhere.

Stated exactly:

> No key bearing `memories:write:shared` **or** `*` has published a shared row.

That is a claim about the keys actually issued, verified by an inventory check, not by reading chart
templates. It belongs to the enablement gate (MCAA-286), which already owns the wildcard condition
(condition 3 above). It is also why the "remediation includes purging `corpus_artifacts`"
consequence can bite earlier than the manifest reading suggests: the reachability does not wait for
a curator key to be minted.

The read side is not symmetric, and that asymmetry is checked rather than assumed: `*` does not
widen a read across tenants. Reading shared rows still requires an explicit `scope: "shared"` or
`CLAUDE_MEM_INCLUDE_SHARED`, and the one wildcard-sensitive read branch (`include=payload` on
`GET /v1/jobs`) still resolves `teamId` from the key rather than the request. The publish path is
the only one a wildcard key widens.

Lens: **delivery-guarantee honesty**, applied to a security precondition rather than a message one.
A precondition written one notch stronger than the code enforces reads as a guarantee, and is not
one. Credit to the Workflow & Eventing Engineer, who caught this in the severity statement of the
corpus ruling above.

## Ratification: reducing the cross-tenant row is not a breaking change

The design review of PR #8 raised a fair question. A pre-existing MCAA-237 test,
`returns both tenants only for an explicit shared-scope query`, asserted that a cross-tenant shared
read **does** carry the publisher's `teamId`. So the previous contract did not merely happen to
expose it -- it pinned it, and removing it reverses a contract term rather than tightening an
unspecified one. This ADR's own rule is that a breaking contract change ships with a version and a
migration path.

**Decision: no endpoint version. The reduction ships as-is.** Two verified facts, not the
convenience of the change, carry this:

1. **The owner view is byte-identical.** The projection diverges from the pre-change serializer
   only on the non-owner branch; the ten owner-view fields are the same fields in the same order.
   Every read that has ever returned data in any deployment is unaffected.
2. **No consumer of the changed branch can exist.** The branch only returns data to a caller that
   asked for it: an explicit `scope: "shared"` on the request, or `CLAUDE_MEM_INCLUDE_SHARED`, which
   resolves falsy when unset. Nothing widens that read implicitly -- notably not a wildcard key, per
   the section above -- so the set of callers that have ever seen a cross-tenant row is bounded by an
   opt-in nobody has taken, and no chart exists to take it.

   This deliberately rests on the **read** opt-in rather than on the publish grant. An earlier
   revision argued it from the absence of a minted `memories:write:shared` key; that argument is
   weaker than it looked, because a wildcard key can publish. The read opt-in is the property that
   actually bounds the consumer set, and it is unaffected by key inventory.

"Backward compatibility by default" protects a consumer you cannot see and cannot redeploy. Here the
code path that would have *delivered* the data to any caller has never been switched on, so the set
of possible consumers is empty -- this is the first definition of the shared-row shape, not a
reduction of a shipped one. The test that pinned `teamId` was asserting the behaviour of a branch no
caller had opted into, which is why correcting it is the right move rather than a contract violation.

**This window closes at the enablement gate.** Once MCAA-286 enables the shared scope in a real
deployment, the shape above becomes a shipped contract and any later removal needs a version and a
migration path. The conditions below exist because deciding now is free and deciding later is not.

## Conditions carried to the enablement gate (MCAA-286)

1. ~~**Re-confirm or drop `sharedOrigin` before shared scope is enabled anywhere.**~~ **Resolved
   2026-09-28: dropped.** No consumer reads the field, so there was nothing to re-confirm it
   against, and it was the last correlation channel on a projected row. Rationale is in the
   shared-row shape section above; the removal is MCAA-346, gated to land before enablement. The
   normative shared view is now six fields: `id`, `kind`, `content`, `shared`, `createdAtEpoch`,
   `updatedAtEpoch`.
2. **Admitting any key to `SHARED_METADATA_ALLOWLIST` is a trust-boundary change.** It requires an
   amendment to this ADR naming the key and why it is publishable, plus a test asserting that the
   admitted key -- and only that key -- survives the projection.
3. **The owner view must stay byte-identical to the shape recorded above.** That equality is what
   makes this change non-breaking, so it is the first thing a future reviewer should check when the
   projection is touched.
4. **The corpus surface reconciles onto the single projection.** ~~Carried to the enablement
   gate.~~ **Upgraded 2026-09-28 to a condition on merging PR #7**, because the divergence is not
   only a shape difference: it discloses another tenant's `projectId` and `metadata` to an ordinary
   read/write caller, and persists that disclosure in `corpus_artifacts`. See the revised finding
   above. Required, and ordered:

   1. **Merge order is projection first.** PR #8 lands, PR #7 rebases onto it. The reverse order
      puts an independently vulnerable surface on `main`, and a temporary second redaction
      implementation is not acceptable as a bridge.
   2. **`serializeSource` and `renderCorpus`'s `redactProvenance` branch produce the shared view by
      calling `serializeObservationForViewer`**, not by re-deriving it.
   3. **It is not one import.** The earlier wording of this condition said the third copy
      disappears with an import; that is wrong, and the correction matters because a rebase can
      appear to satisfy the wrong version. `serializeObservationForViewer` decides via
      `isOwnerAuthorizedView(row, viewer)`, which needs `row.teamId` -- and the corpus member row
      has none: `MemberRow` is `{ id, project_id, kind, content, metadata, shared, created_at,
      updated_at }` and the `listMembers` SELECT never projects `observations.team_id`. The
      per-member decision is currently impossible to express. Reconciling means `listMembers` also
      selects `observations.team_id`, threading it through `PostgresCorpusMember`, and only then
      calling the projection per member.
   4. **The ownership test is per member, not per corpus**, and the viewer is the authenticated
      reader's team plus the project that reader is authorized for -- never the corpus's team, and
      never a project read off the container. Corpus-level authorization stays separate from member
      projection.
   5. **Purge `corpus_artifacts` as part of the fix.** The leak is stored state, so a code fix alone
      leaves primed renders that already contain foreign provenance.
   6. **Correct the contract comment** in `corpus-v1.ts` that justifies the member field set as
      parity with `POST /v1/search { scope: "shared" }`. That premise is what made the defect read
      as already handled.

   The second security review on MCAA-348 attaches further first-release conditions to this surface
   that go beyond response fields -- metadata *inference* channels (`metadataMatch` applied to
   foreign rows, membership counts), the unkeyed `corpusFilterDigest`, and derived statistics such
   as `tokenEstimate` computed from renders that included private metadata. Those belong to the
   corpus contract record (MCAA-259), not to this ADR, and folding them in is my next action there.
   They are gates on the corpus surface, not on PR #8.

## Consequences

- The Helm chart (MCAA-229) and the OpenClaw integration (MCAA-231) consume a fixed env-var and
  MCP contract: `CLAUDE_MEM_SERVER_URL`, `CLAUDE_MEM_API_KEY`, `CLAUDE_MEM_PROJECT_ID` required,
  `CLAUDE_MEM_AGENT_ID` / `CLAUDE_MEM_INCLUDE_SHARED` / `CLAUDE_MEM_RUNTIME` optional, MCP over
  streamable HTTP at `/v1/mcp` with a bearer header, liveness at `/healthz`.
- Two key classes now exist. That is a provisioning requirement on the chart, not a suggestion:
  agent keys and one curator key.
- Un-publishing without deleting is not possible in this version: there is no observation update
  route, so retraction means `DELETE /v1/memories/:id` by the owning tenant. Acceptable because
  retraction exists and is owner-only; if curated knowledge needs editing in place, that is a new
  decision about an update route, not a change to this one.
- Agent identity travels as `metadata.agentId` rather than a column. It is an attribution field, not
  a filter; promoting it to a column is an additive change if we ever need to query by it.
- Nothing is hard-coded to one operator: every address, credential and identifier comes from
  configuration, so a fork points at its own server (the fork-ability contract).
- Row-level security remains available as a later hardening step. This decision does not foreclose
  it -- the predicate is already centralized in one repository class.

## Compatibility tests

- `tests/server/runtime/tenant-isolation-routes.test.ts` -- two keys, two tenants, over the wire:
  default reads are tenant-only, a forged `projectId` returns nothing, an unrecognised scope fails
  closed, and a shared row is readable but not deletable by a non-owner. `scope: "shared"` returns
  both tenants' content through the shared projection: the publisher's project id appears nowhere in
  the response body, on REST search/context or on any of the three MCP tools. A same-team row
  published outside the queried project gets the same projection, and the same row read from its own
  project still returns the owner view, which pins the boundary from both sides.
  PR #12 rewrites this file's harness as well, but unlike the generation suite below that merge needs
  no resolution choice: verified 2026-09-28, the PR #8 / PR #12 auto-merge carries all 21 titles with
  zero removed from either side, and keeps PR #12's `createIsolatedSchema` harness with no
  `pool.on('connect')` listener left behind.
- `tests/server/routes/observation-projection.test.ts` -- the projection's own rules. It must assert
  the surviving key set as an **exact set**, not as a list of absences, so a field added to the
  shared view later cannot pass silently. (PR #8 asserts the set that still includes `sharedOrigin`,
  plus that token's stability; MCAA-346 reduces both to the six-field set.)
- `tests/server/generation/process-generated-response.test.ts` -- the derived-observation guarantee
  above, pinned by two tests **named here on purpose**:
  `keeps a per-event generated observation private despite shared-looking input` and
  `keeps a session-summary generated observation private despite shared-looking input`. Each asserts
  the persisted row, the returned object and the `observation.created` audit entry.
  The file's other tests are unrelated to this decision, and PR #11/#12 rewrite that file's
  whole harness (`pool.on('connect')` -> `createIsolatedSchema`/`poolForSchema`). Resolving that
  conflict by taking either side wholesale compiles, passes, and deletes these two: the workflow
  still names the file, so the gate stays green while the property stops being tested. **A merge
  resolution that does not leave both names in the file is a regression of this decision regardless
  of CI colour.**

  The acceptance is the two titles, never a test count. A count is
  instrument-dependent and this one already disagreed with itself: the file opens with
  `it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration')`, which a
  `^\s*it\(` grep cannot see. That grep reports 15 titles on PR #8's branch and 13 on `main`,
  PR #11 and PR #12; the AST inventory below reports 16 and 14. Both are right about the delta and
  neither is a usable acceptance criterion, because a reader checking the wrong instrument sees a
  mismatch that is not one. Verified 2026-09-28 with `scripts/test-names.ts` itself, diffing PR #8's
  copy against PR #11's: `16 -> 14`, removed titles exactly these two and nothing else.
- `tests/storage/shared-scope-migration.test.ts` -- forward DDL is idempotent and the
  `SHARED_SCOPE_DOWN_SQL` round trip restores the pre-change shape.
- `tests/shared/remote-mode.test.ts` -- trigger precedence, including that an under-configured
  legacy `runtime=server` settings file keeps its worker fallback.
- `tests/shared/remote-mode-no-local-state.test.ts` -- no worker spawn and no local database open
  in remote mode.
- `.github/workflows/ci.yml` runs the tenant-isolation job against a real Postgres, so the
  isolation guarantee blocks the build. Both suites above must stay named in that job:
  `process-generated-response.test.ts` was gated on `CLAUDE_MEM_TEST_POSTGRES_URL` that no job
  supplied, so it reported green for months without ever executing. A gate whose failure mode is
  silence is not a gate.
- `dropped-test guard (gated suites)` (PR #18, MCAA-395) enforces the paragraph above by machine
  rather than by review. It extracts test titles with the TypeScript compiler, compares each changed
  gated suite against the merge base as a per-title multiset, and fails the build on a title present
  at base and absent at head. So "a regression of this decision regardless of CI colour" is now a
  regression CI colour reports. Two properties make it hold for this decision specifically: it scopes
  a file in by the **union** of the gate markers found in the base and head sources, so a resolution
  cannot escape the check by also deleting the `CLAUDE_MEM_TEST_POSTGRES_URL` guard; and it compares
  multiplicities rather than a set, so one of two same-titled tests disappearing still fails.

  Stated limits, so nobody reads the guard as wider than it is. `it.each`/`test.each` titles are
  computed at runtime and invisible to a source scan, so the inventory is a floor. It catches a
  deleted assertion, not a relocated one: a guard re-applied to the wrong function removes no title
  and stays green. A rename reads as a removal plus an addition, so a deliberate one has to be
  declared.

  The fourth limit is scope, and it is the one a reader is most likely to infer past.
  `check-test-name-removals.ts` inspects only suites that already exist at the merge base and carry
  a gate marker: it diffs with `--diff-filter=MDR`, skips any path with no base blob, and skips any
  path neither the base nor the head source marks with a `CLAUDE_MEM_TEST_*` gate. Deleting a whole
  gated suite is still caught -- the head source reads empty and every title is reported -- but a
  suite that arrives new on a branch is never inspected at all. That is correct by construction,
  since a file with no base side cannot have lost a title. Its consequence is not: a green
  `dropped-test guard (gated suites)` is evidence about edited, renamed and deleted gated suites,
  and is not assurance that a rebase preserved every test in the tree.

  Both suites this decision names are on `main` and gated, so this decision's own compatibility
  tests are in scope. MCAA-394's is the case that is not, and it fails the guard's preconditions
  three times over rather than once: its suite is absent from `main`, it reads no
  `CLAUDE_MEM_TEST_*` because it drives a fake queryable, and its defect relocates a guard statement
  without removing a title. Adding the named `createIfAbsent` test does not bring it under this
  check -- that resolution is verified by hand. Recording the three causes because a reader who
  knows only the relocation one will conclude that a test fixes it.

  **The two ways to declare a removal are not equivalent, and only one of them may be used on the
  two titles named above.** `check-test-name-removals.ts` computes
  `const waived = labelled || isWaived(removal.title, waivers)`. A
  `Removed-test: "<exact title>" <why>` commit trailer waives that one title and names it; the
  `tests-removed` pull-request label is a single boolean that waives **every** removal in **every**
  gated suite in that pull request and names none of them. So a pull request that legitimately
  renames one test and accidentally drops these two is green under the label, with nothing in the
  build output for a reviewer to read. For this decision the label is not an acceptable
  declaration: a removal of either named title is declared by trailer, or it is not declared.
  Verified 2026-09-28 against PR #18 at `b8e60371`.

  For the conflict this section warns about, the correct resolution declares **nothing**, because it
  removes nothing. Measured with `scripts/test-names.ts`: PR #11 and PR #8 each remove zero titles
  from this suite relative to `main` (14 and 16 titles against `main`'s 14), and only the
  take-one-side-wholesale resolution removes any -- exactly the two named above. A red
  `dropped-test guard` on that rebase therefore means the resolution is wrong, not that a waiver is
  missing.

  This guard and the `docs/adr/README.md` conventions are the same rule at two altitudes -- the
  record says which assertions the decision owns, the guard refuses to let one disappear -- and
  neither substitutes for the other.
