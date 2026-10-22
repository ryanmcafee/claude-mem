# 0004. Per-agent GitHub identity: role-scoped principals and run-bound attribution

Status: accepted

A cross-boundary design authored by the Principal Platform Architect, who does not approve their
own. The second-reviewer pass (MCAA-692, Security & Secrets Engineer) returned
**approve-with-conditions**. Every condition is incorporated below and listed in
[Review conditions incorporated](#review-conditions-incorporated).

## Context

Every agent in this company acts on GitHub as the same actor. The following was measured on
2026-09-29 and 2026-09-30, not inferred:

| Fact | Value | How it was checked |
| --- | --- | --- |
| Actor for every agent's GitHub call | user `ryanmcafee` | `gh auth status`, `gh api user` |
| Token type | GitHub App **user-to-server** (`ghu_` prefix) | token prefix; `X-OAuth-Scopes` is empty on `GET /user`, which an OAuth token would populate |
| App and installation | `paperclip-for-github`, installation `163935843`, target `ryanmcafee`, `repository_selection: all` | `GET /user/installations` |
| Permissions the token is capped at | `contents:write`, `pull_requests:write`, `issues:write`, `workflows:write`, `actions:read`, `checks:read`, `deployments:read`, `statuses:read`, `metadata:read` | same call |
| Commit author and committer handed to every agent | `ryanmcafee <2336262+ryanmcafee@users.noreply.github.com>` | `git var GIT_AUTHOR_IDENT` under the managed launcher |
| Commit identity when the broker returns nothing | `probe <agent@paperclip.ing>`, from the shared checkout's `.git/config` | `git config --show-origin --get-all user.name` |
| Per-agent marker in commits today | none; trailers name the model and the platform (`Paperclip`) | `git log` on agent branches |
| Author of every open pull request (#14 through #25) | `ryanmcafee` | `gh pr list --json author` |
| How the credential arrives | a run-scoped launcher shadows `git` and `gh` on `PATH`, strips inherited `GH_TOKEN`/`GIT_*`/SSH variables, then `POST`s `/runtime-tools/github/credentials` with a per-run capability token and injects the result into that one invocation | the launcher source at `$PAPERCLIP_GITHUB_LAUNCHER_DIR/gh` |

### One correction to the framing that raised this

MCAA-659 states that an agent needing only to read pull-request state "holds admin on every repo."
That overstates it. The token is capped by the installation permission set above; it cannot
administer a repository, change branch protection, or read a secret. What is genuinely absent is a
**per-agent narrowing seam**: every agent receives the same cap, and that cap includes
`contents:write` together with `workflows:write`. So a reviewing agent can rewrite the CI workflow
that gates the change it is reviewing. That is the least-privilege defect worth naming, and it is
narrower and more actionable than "admin on everything."

### The three properties, and why they are unrepresentable rather than unbuilt

1. **Author-distinct review.** GitHub refuses to record an approving review from a pull request's
   own author. With one actor, every agent is every pull request's author. The policy bar on
   MCAA-520 -- "a second-reviewer pass that is not its own author" -- is sound, has been met
   repeatedly at the board level, and has no GitHub-native form at all. This is what deadlocked
   MCAA-281.
2. **Attribution.** Commits, comments and reviews all collapse to one actor, and the commit
   trailers name a model and a platform rather than a decision-maker. "Which agent decided this"
   is answerable only by correlating board issues against timestamps. That is a reconstruction, not
   an audit trail.
3. **Least privilege.** One principal means one permission set. There is no seam at which to give a
   reviewing agent less than an authoring one.

### A constraint that shapes every option

The credential broker, the run launcher and the GitHub App are Paperclip's. We hold neither the
app private key nor the code that decides which principal to mint. Any option that changes *which
GitHub principal a run acts as*, or what the control plane records about a run's GitHub writes, is
a request on a third party, not a change we can land in this repository. This record therefore
separates what we decide from what we request, and commits to a fallback that holds if the request
is declined. Writing a decision whose whole value depends on someone else saying yes would not be a
decision.

## Decision drivers

- **Trust boundaries.** An identity that cannot be distinguished cannot be authorized separately or
  audited separately. Both failures follow from the same missing distinction.
- **Extension seam, not fork.** We sell AI agent identity as a BYO-\* extension point. We operate
  zero of them. Building it internally is the same bones, not a second copy.
- **Shared bones, not copies.** A claude-mem-specific workaround gets solved a second time for
  homelab.
- **The fork-ability contract.** A stranger forking `ryanmcafee/homelab` must be able to run this.
  Any option whose setup cost grows with the number of agents fails that contract outright.
- **Reversibility.** Attribution written into commit messages is permanent, and a false attribution
  in git history is hard to walk back. Spend the analysis budget there.
- **Boring is a feature.** Git trailers and app installations are dull, documented mechanisms.

## Options considered

### Option A -- one GitHub App per agent

Each agent gets its own app, acting as `mcaa-architect[bot]` and so on. The broker mints an
installation token per agent.

- Attribution becomes fully native. Author-distinct review works between any two agents. Each app
  carries its own permission set, so least privilege is exact.
- Registering, installing, and rotating keys for one app per agent is `O(agents)` on a
  human-administered axis. Eighteen today; every hire adds a manual GitHub step.
- A fork must register `N` apps before the platform functions. That is a direct violation of the
  fork-ability contract, not a rough edge.
- Key custody blast radius grows linearly with the agent count.

Rejected: correct on every property we want, at a setup cost that scales on the one axis that must
stay flat.

### Option B -- a machine user per agent

One GitHub account per agent.

- Attribution, reviews, mentions and assignment all behave exactly as they do for humans. Nothing
  needs to be explained to a reader.
- GitHub's terms permit a machine account bound to a person or organization; they do not permit one
  party maintaining eighteen free accounts. In an organization each is a billable seat.
- Every account needs credentials, two-factor enrollment and a recovery path -- again
  `O(agents)`, again human-administered, and now with eighteen recovery secrets to hold.
- Same fork-path failure as Option A.

Rejected: the strongest native behaviour, bought with terms-of-service exposure, per-seat cost, and
eighteen credential lifecycles.

### Option C -- one bot principal, attribution carried out of band

The broker mints an **installation** access token (`ghs_`) instead of a user-to-server token. The
actor becomes `paperclip-for-github[bot]`.

- The cheapest possible change: the app already exists and is already installed.
- It immediately makes author-distinct review representable *between the bot and any human*. A
  person can approve a bot-authored pull request. That alone would have resolved MCAA-281.
- All eighteen agents still collapse to one actor, so agent-to-agent author-distinct review remains
  impossible, and attribution is no better than today -- only differently wrong.
- Least privilege is unchanged: still one cap for all agents.
- An app cannot approve a pull request it authored either, so a bot-authored, bot-reviewed change
  stays blocked.

Rejected as a destination, kept as the floor: it is strictly better than the status quo and is the
first increment of the chosen option.

### Option D -- role-scoped principals plus run-bound per-agent attribution (chosen)

Split the problem along the axis where the costs actually differ.

1. **The principal is a function of the agent's role, not its identity.** Two app identities, an
   **author** principal and a **review** principal, with the permission sets in
   [Permission matrix](#permission-matrix). The role is assigned by the control plane, never
   requested by the agent. This is `O(roles)` -- two to four -- not `O(agents)`.
2. **Attribution is a trailer bound to a server-captured run record.** Every commit an agent
   authors carries `Paperclip-Agent`, `Paperclip-Agent-Id` and `Paperclip-Run` trailers; every
   agent-authored pull request body, review body and issue comment carries the same three as a
   footer. A trailer alone is a **self-asserted label**. It becomes attribution only when it
   matches the control plane's own record of which run wrote that exact GitHub object (see
   [boundary 4](#trust-boundaries)).

Why the combination rather than either half:

- It makes author-distinct review **GitHub-native**. An authoring agent's pull request is authored
  by the author principal; a reviewing agent approves as the review principal. Different principals,
  so GitHub records the approval. The MCAA-281 deadlock cannot recur as a mechanism.
- It puts the least-privilege seam where the risk actually is. Today a reviewing agent can rewrite
  the workflow it is reviewing against. Under this split the review principal holds no repository
  contents or workflow write, so that capability is removed rather than discouraged. Merging also
  requires contents write, so a review principal cannot merge.
- It keeps the fork path viable. A fork registers two apps, or runs degraded with one. Setup cost
  does not grow when the fork adds agents.
- Per-agent granularity -- the part that genuinely needs to be per-agent -- is carried by trailers
  plus the run binding, which cost nothing per agent and which a fork inherits for free.

### Option E -- accept the shared account and record review at the board level

Keep one actor; make the board the record of review and name a merge authority per repository.

- Zero implementation. It is also already true in practice, and it is the correct immediate answer
  to MCAA-658.
- Attribution and least privilege stay broken, and the question recurs on every repository.

Not chosen as the decision. Adopted as the *fallback*, and part of it is adopted unconditionally
(see decision item 3), because the review-of-record policy is needed today whatever happens to the
principal.

## Decision

1. **The GitHub principal a run acts as is a function of the agent's role, not its identity.** Two
   principals, `author` and `review`, with the permission sets in the matrix below. The broker
   derives the role from server-controlled assignment and policy, binds it into the run capability
   at issue time, and denies both unknown roles and any attempt by a run to obtain a role other
   than the one bound to it.
2. **Per-agent attribution is carried in structured trailers, never in the GitHub actor, and is
   only ever reported when a server-captured run binding confirms it.** `Paperclip-Agent`,
   `Paperclip-Agent-Id` and `Paperclip-Run` on every commit, and as a footer on every agent-authored
   pull request body, review body and issue comment. Without the binding they are labels and are
   described as labels.
3. **Until item 1 lands, the record of review is the Paperclip board**, and merge authority for a
   repository is whatever its governing board issue names. A review that cannot be recorded on
   GitHub is not evidence that a change went unreviewed. This holds whether or not items 1 and 4
   are ever granted.
4. **The review principal never holds `contents:write` or `workflows:write`.** It does hold
   `pull_requests:write`, which is required to submit a review and also allows editing or closing
   pull-request metadata; the claim is "no repository contents or workflow write," not "no write."
   If only one principal is ever available, reviewing agents get read-only credentials and merges go
   through the board's named authority.
5. **We ship this shape as the BYO-agent-identity contract**, rather than describing it only
   internally: an `AgentIdentity` of `{ subject, role, principalRef, attributionTrailers }` resolved
   by a pluggable `IdentityBroker`. Role authorization and the run-to-object binding live at that
   seam, not in callers. Homelab and the commercial platform get the same interface; the only
   difference is which broker implementation is configured. A customer-specific broker is a
   configuration, never a branch.
6. **Credential-dependent operations fail closed when the broker does not return a credential.**
   See [Blast radius](#blast-radius-what-breaks-when-the-broker-is-unavailable).

### Permission matrix

| Permission | `author` | `review` | Justifying call |
| --- | --- | --- | --- |
| `contents` | write | read | push; merge requires contents write; review reads the diff |
| `pull_requests` | write | write | open and update a PR; submit a review |
| `checks` | read | read | read CI status before claiming green |
| `actions` | read | read | pull failing job logs |
| `metadata` | read | read | mandatory for any installation |
| `issues` | -- | -- | omitted: no required GitHub-issue operation; PR conversation comments are covered by `pull_requests` |
| `workflows` | -- | -- | omitted: no required call; `workflows:write` is deliberately absent from both |

Legitimate workflow edits do not ride on either principal. Until a separate, reviewed path is
designed in its own record, they are made by a human-held credential. The update-branch endpoint
needs contents write on the head repository, so only the author principal can use it -- that is
intended.

The broker checks **effective** permissions at mint time: the `permissions` object returned with a
minted installation token must equal the declared set for the bound role, and a mismatch is a
refusal to hand out the token. A declared role is not trusted as evidence of what the token can do.

### Sequencing

Option C is the first increment of item 1, not a competing path: moving from a user-to-server token
to an installation token yields one bot principal, which unblocks human-approves-agent immediately.
The second principal follows and unblocks agent-approves-agent. Items 2, 3 and 5 are independent of
both and start now, with item 2 reporting labels only until the run binding exists.

## What we decide versus what we request

**We control**, and are therefore deciding: the trailer format and the verifier that consumes it,
the review-record-of-record policy (item 3), branch protection on repositories we own, the
`IdentityBroker` interface we ship (item 5), and the scope of the `paperclip-for-github`
installation on our account (see [Key custody](#key-custody-and-residual-third-party-trust)).

**We do not control** which GitHub principal Paperclip's broker mints, how the broker derives a
run's role, whether the control plane records a run-to-object binding, or whether the launcher
fails closed. Items 1, 4, 6 and the binding half of item 2 are a request on Paperclip. Because it is
a hard third-party dependency sitting under our entire SDLC, that request is a founder escalation
rather than an engineering ticket.

**If the request is declined**, the fallback is **board-recorded review plus unverified labels**:

- Items 3 and 5 stand unchanged. Item 2 still ships, but its trailers are self-asserted labels that
  aid search and are never presented as provenance.
- Item 4 degrades from a permission to a policy: reviewing agents are instructed not to push, with
  no mechanism preventing it.
- Agent-to-agent GitHub approval and enforceable review-token isolation remain unavailable.
- Merge authority stays with the named authority on the governing board issue.

That fallback is worse than the decision and strictly better than today, and it is what we will
operate until the request is granted.

## Trust boundaries

1. **Agent run to credential broker.** Crossed by a per-run capability token. The broker authorizes
   it against the run and, under item 1, against the role bound to the run at issue time. An agent
   cannot select its role. Compromise of a capability yields that role's cap for the run's
   lifetime, not the other role's.
2. **Broker to GitHub.** Crossed by an app private key exchanged for a token. We hold neither. See
   [Key custody](#key-custody-and-residual-third-party-trust).
3. **Agent to repository contents.** Today a single boundary shared by all agents. Under this
   decision, two, with the sharper one on the reviewing side.
4. **Trailer to audit consumer.** **Trailers are self-asserted.** A commit message or PR footer can
   claim any `Paperclip-Agent` value, and nothing in git prevents it. Agent id, run id, timestamps
   and the pushed ref are **not** evidence: another author agent can copy a visible run tuple, set
   commit timestamps, and push to the same mutable ref.
   - **Authoritative evidence** is an immutable, server-captured binding from a run to the exact
     GitHub objects it wrote: the commit SHAs introduced by each push the broker credentialed (the
     ref's old and new SHA at push time), and the node id of each pull request, review and comment
     it created. The control plane records this at operation time; the agent cannot write it.
   - The verifier reports a trailer as attributed **only** when exactly one binding covers that
     object and names the same run and agent as the trailer. What that proves is "introduced to
     GitHub by run R of agent A," which is the claim it makes -- nothing more.
   - A missing binding resolves to `unattributed`. Two bindings claiming one object, or a trailer
     that disagrees with its binding, resolve to `ambiguous`. Neither ever resolves to the claimed
     agent.
   - Until that binding exists, trailers are called *self-asserted labels* everywhere, including
     tooling output. A false positive written into git history is hard to reverse, which is why
     this boundary carries the strictest wording in the record.
5. **Fork boundary.** A forked deployment supplies its own broker and its own apps. Nothing in the
   trailer format or the `IdentityBroker` interface may name our installation, our app slug, our
   account, or our broker host.

## Key custody and residual third-party trust

Paperclip holds the app private key and runs the minting service. Its key can mint tokens for every
installation granted to `paperclip-for-github`, outside any run policy we define. Our controls
reduce **our** blast radius; they cannot constrain a compromised provider across its other
tenants. That residual trust is accepted explicitly, not assumed away.

Controls we operate:

- **Narrow the installation** from `repository_selection: all` to the selected repositories agents
  actually work in.
- **Keep grants minimal**: the installation cap is the union of the permission matrix, which drops
  `issues:write`, `workflows:write`, `deployments:read` and `statuses:read` from today's cap.
- **Protect default branches** with no bypass for the app. A required approving review is enabled
  once the authoring actor is distinct from every eligible approver -- at Option C for human
  approvers, at item 1 for agent approvers. Before then it re-creates the MCAA-281 deadlock as a
  setting (see [Compatibility and migration](#compatibility-and-migration)).
- **Audit what is visible to us**: the account security log for app authorization and installation
  events, and the control plane's run records for issued credentials. Per-token use events are not
  exposed to a personal account; that gap is named, not papered over.
- **Revocation**: suspend or uninstall the `paperclip-for-github` installation from the account's
  application settings, and revoke the user authorization that backs `ghu_` tokens. Either stops
  new mints; outstanding installation tokens expire within an hour.

## Blast radius: what breaks when the broker is unavailable

This is not hypothetical. The broker returned 401 for several agents earlier in this work queue
while resolving normally for others. The launcher's behaviour is written in its own source: on
401 or 403 it emits `capability_rejected`; on other failures, `broker_response_unavailable` or
`broker_transport_unavailable`. In every case it then **spawns `git` or `gh` without credentials
rather than failing**.

What that actually allows today:

- **Local writes succeed.** `user.useConfigOnly=true` only stops git inventing an author from the OS
  user; it does not override an identity already configured. The shared checkout's `.git/config`
  sets `probe <agent@paperclip.ing>`, so `git commit`, `git branch` and `git add` all succeed during
  an outage, under an identity that is neither the agent nor the principal.
- **Authenticated pushes fail**, provided no alternate credential route exists. The launcher blanks
  `credential.helper` and `core.askPass`, rewrites SSH remotes to HTTPS, and neuters SSH identities.
  The checked remote carries no embedded credential. A remote with credentials embedded in its URL
  would bypass all of that; nothing currently prevents one.
- **Public reads succeed.**
- The degradation is nearly invisible to the agent's own reasoning. A single stderr line is easy to
  read past, and an agent can plausibly report "pushed" on a run where nothing was pushed.

So this is an integrity risk, not only a reporting defect: an outage produces local commits under a
wrong identity that a later, successful push can carry to GitHub.

Decision item 6 closes it, and is part of the request on Paperclip:

- The launcher refuses to spawn a credential-dependent operation (commit, tag, push, and any `gh`
  write) when the broker returned no credential, and exits non-zero with the diagnostic.
- Genuine broker unavailability surfaces as a first-class blocker on the run's issue, naming owner
  and action, rather than as a stderr line.
- Until then, agents treat any `capability_rejected` or `broker_*_unavailable` diagnostic as a hard
  stop for that operation, and a verifier treats commits whose author is not the minted identity as
  `unattributed`.

Under this decision an outage stalls work rather than corrupting it: a reviewing agent whose broker
call fails cannot record an approval, which stalls a merge instead of corrupting one. That is the
failure direction to prefer.

## Consequences

**Positive.**

- Author-distinct review acquires a GitHub-native form, so the MCAA-281 class of deadlock stops
  recurring rather than being adjudicated per repository.
- "Which agent introduced this object" becomes answerable from the commit plus a server-captured
  binding, instead of by correlating timestamps.
- A reviewing agent loses the ability to rewrite the CI it is reviewing against, and cannot merge.
- We can answer a customer asking how our agents authenticate to their SCM and how to audit which
  agent did what, because we run the same mechanism we sell.

**Negative.**

- Principals remain shared within each role. An agent's individual GitHub authorization is not
  separable from its role's; only the trailer plus binding distinguishes it.
- Paperclip retains key custody across all of its tenants. We narrow our exposure; we do not remove
  it.
- Trailers are permanent once pushed. A format mistake is not reversible in history, only
  superseded going forward. The format must be additive-tolerant from the first commit.
- Items 1, 4, 6 and the binding depend on a third party agreeing. We are choosing a decision we
  cannot fully execute alone, and saying so.
- All history to date stays attributed to `ryanmcafee`, and is `unattributed` per agent. We are not
  rewriting it, so the audit trail has a discontinuity at the date this lands. A record of that
  date is the mitigation.

**Neutral.**

- Trailers are additive; any consumer that does not parse them is unaffected. Git trailers are a
  documented commit-message convention, so existing tooling keeps working.
- Changing the principal changes the actor on future objects only.

## Compatibility and migration

- Do **not** enable a branch-protection rule requiring an approving review until the authoring
  actor is distinct from the intended approvers (Option C for humans, item 1 for agents). Doing so
  earlier re-creates the MCAA-281 deadlock as a repository setting, where it is harder to
  adjudicate than as a policy question.
- The trailer set is versioned by being additive: consumers must ignore unknown `Paperclip-*`
  trailers, and a future field is added rather than a field redefined. A breaking change to the set
  requires a superseding record and a migration path, per the standing rule on schemas.
- `AgentIdentity` follows the same additive rule. `principalRef` is opaque to consumers; its shape
  is the broker implementation's business, which is what keeps a BYO broker from needing a fork.

## Compatibility tests

These do not exist yet. They are the acceptance criteria of the implementation work, named here so
the implementing engineer inherits them rather than inventing them.

- `AgentIdentity` round-trips, and a payload carrying an unknown additional field still
  deserializes.
- A commit message carrying the three trailers parses back to the same agent id; a message carrying
  an unknown extra `Paperclip-*` trailer still parses; a message with no trailers yields
  `unattributed` and never a default agent.
- A trailer with no run binding for its object resolves to `unattributed`, not to the claimed agent.
- **Cross-run same-ref forgery:** run A pushes to a ref; run B, a different author agent, pushes a
  commit to the same ref whose trailers copy run A's agent id and run id and whose timestamps fall
  inside run A's window. The verifier resolves B's commit to run B (from the binding) or
  `ambiguous`, never to run A.
- Two bindings claiming the same object resolve to `ambiguous`.
- Role selection: a run bound to `review` cannot mint an `author` token, an unknown role is denied,
  and a run cannot change its bound role.
- Mint-time effective permissions: a minted token whose returned `permissions` differ from the
  bound role's declared set is refused.
- **Broker denied:** with the broker returning 401, a local commit, an authenticated push, and a
  `gh` write each exit non-zero before the child process runs, and the run's issue gains a blocker.

## Review conditions incorporated

From the MCAA-692 second-reviewer pass (approve-with-conditions):

| Condition | Where it is met |
| --- | --- |
| Authoritative evidence for attribution; reject duplicate or ambiguous claims; `unattributed` without a binding; forgery test; "self-asserted labels" until then | boundary 4, decision item 2, compatibility tests |
| Role derived server-side and bound to the run capability; deny self-escalation and unknown roles; test; truthful review-token claim | decision items 1 and 4, boundary 1, compatibility tests |
| Residual third-party key custody named; controls we operate | Key custody and residual third-party trust |
| Justify or omit `issues:write` and `workflows:read`; no `workflows:write`; separate workflow-edit path; mint-time effective-permission test | Permission matrix, compatibility tests |
| Fallback labelled board-recorded review plus unverified labels; unavailable properties stated; named merge authority retained | What we decide versus what we request |
| Broker outage claims corrected; fail closed before spawning; broker-denied test; first-class blocker | Blast radius, decision item 6, compatibility tests |

## Related

- MCAA-659 -- this record.
- MCAA-692 -- the second-reviewer pass whose conditions are incorporated above.
- MCAA-658 -- the immediate merge-authority ruling. Decision item 3 is the durable half of it.
- MCAA-281 -- the deadlock that surfaced the defect.
- MCAA-520 -- the second-reviewer policy bar that has no GitHub-native form today.
- MCAA-343 -- the shared working tree. The same class of defect: one shared resource where the
  design assumes one per agent.
