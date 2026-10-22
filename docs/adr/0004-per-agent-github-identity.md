# 0004. Per-agent GitHub identity: role-scoped principals and verifiable attribution

Status: proposed

A cross-boundary design authored by the Principal Platform Architect, who does not approve their
own. It becomes `accepted` on a second reviewer's pass, recorded on MCAA-659.

## Context

Every agent in this company acts on GitHub as the same actor. The following was measured on
2026-09-29, not inferred:

| Fact | Value | How it was checked |
| --- | --- | --- |
| Actor for every agent's GitHub call | user `ryanmcafee` | `gh auth status`, `gh api user` |
| Token type | GitHub App **user-to-server** (`ghu_` prefix) | token prefix; `X-OAuth-Scopes` is empty on `GET /user`, which an OAuth token would populate |
| App and installation | `paperclip-for-github`, installation `163935843`, target `ryanmcafee`, `repository_selection: all` | `GET /user/installations` |
| Permissions the token is capped at | `contents:write`, `pull_requests:write`, `issues:write`, `workflows:write`, `actions:read`, `checks:read`, `deployments:read`, `statuses:read`, `metadata:read` | same call |
| Commit author and committer handed to every agent | `ryanmcafee <2336262+ryanmcafee@users.noreply.github.com>` | `git var GIT_AUTHOR_IDENT` under the managed launcher |
| Per-agent marker in commits today | none; trailers name the model (`Claude Opus 5`) and the platform (`Paperclip`) | `git log` on agent branches |
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

The credential broker is Paperclip's, and the GitHub App is Paperclip's. We hold neither the app
private key nor the code that decides which principal to mint. Any option that changes *which
GitHub principal a run acts as* is a request on a third party, not a change we can land in this
repository. This record therefore separates what we decide from what we request, and commits to a
fallback that holds if the request is declined. Writing a decision whose whole value depends on
someone else saying yes would not be a decision.

## Decision drivers

- **Trust boundaries.** An identity that cannot be distinguished cannot be authorized separately or
  audited separately. Both failures follow from the same missing distinction.
- **Extension seam, not fork.** We sell AI agent identity as a BYO-\* extension point. We operate
  zero of them. Building it internally is the same bones, not a second copy.
- **Shared bones, not copies.** A claude-mem-specific workaround gets solved a second time for
  homelab.
- **The fork-ability contract.** A stranger forking `ryanmcafee/homelab` must be able to run this.
  Any option whose setup cost grows with the number of agents fails that contract outright.
- **Reversibility.** Attribution written into commit messages is permanent; a principal change
  affects only future objects. Spend the analysis budget accordingly.
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

### Option D -- role-scoped principals plus verifiable per-agent attribution (chosen)

Split the problem along the axis where the costs actually differ.

1. **The principal is a function of the agent's role, not its identity.** Two app identities:
   an **author** principal (`contents:write`, `pull_requests:write`, `issues:write`,
   `workflows:read`) and a **review** principal (`pull_requests:write`, `checks:read`,
   `contents:read`, and no write of any kind). The broker selects the principal from the role
   declared for the run. This is `O(roles)` -- two to four -- not `O(agents)`.
2. **Attribution is a structured, reconcilable trailer.** Every commit an agent authors carries
   `Paperclip-Agent`, `Paperclip-Agent-Id` and `Paperclip-Run` trailers; every agent-authored pull
   request body, review body and issue comment carries the same three as a footer. Attribution
   becomes data we own and can check, rather than a GitHub object we must administer per hire.

Why the combination rather than either half:

- It makes author-distinct review **GitHub-native**. An authoring agent's pull request is authored
  by the author principal; a reviewing agent approves as the review principal. Different principals,
  so GitHub records the approval. The MCAA-281 deadlock cannot recur as a mechanism.
- It puts the least-privilege seam where the risk actually is. Today a reviewing agent can rewrite
  the workflow it is reviewing against. Under this split the review principal cannot push and cannot
  touch workflows, so that capability is removed rather than discouraged.
- It keeps the fork path viable. A fork registers two apps, or runs degraded with one. Setup cost
  does not grow when the fork adds agents.
- Per-agent granularity -- the part that genuinely needs to be per-agent -- is carried by trailers,
  which cost nothing per agent and which a fork inherits for free.

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
   principals, `author` and `review`, with the permission sets named in Option D.
2. **Per-agent attribution is carried in structured trailers, never in the GitHub actor.**
   `Paperclip-Agent`, `Paperclip-Agent-Id` and `Paperclip-Run` on every commit, and as a footer on
   every agent-authored pull request body, review body and issue comment.
3. **Until item 1 lands, the record of review is the Paperclip board**, and merge authority for a
   repository is whatever its governing board issue names. A review that cannot be recorded on
   GitHub is not evidence that a change went unreviewed. This holds whether or not items 1 and 4
   are ever granted.
4. **The review principal never holds `contents:write` or `workflows:write`.** If only one principal
   is ever available, reviewing agents get read-only credentials and merges go through the board's
   named authority.
5. **We ship this shape as the BYO-agent-identity contract**, rather than describing it only
   internally: an `AgentIdentity` of `{ subject, role, principalRef, attributionTrailers }` resolved
   by a pluggable `IdentityBroker`. Homelab and the commercial platform get the same interface; the
   only difference is which broker implementation is configured. A customer-specific broker is a
   configuration, never a branch.

### Sequencing

Option C is the first increment of item 1, not a competing path: moving from a user-to-server token
to an installation token yields one bot principal, which unblocks human-approves-agent immediately.
The second principal follows and unblocks agent-approves-agent. Items 2, 3 and 5 are independent of
both and start now.

## What we decide versus what we request

**We control**, and are therefore deciding: the trailer format and the verifier that reconciles it,
the review-record-of-record policy (item 3), branch protection on repositories we own, and the
`IdentityBroker` interface we ship (item 5).

**We do not control** which GitHub principal Paperclip's broker mints. Items 1 and 4 are a request
on Paperclip. Because it is a hard third-party dependency sitting under our entire SDLC, that
request is a founder escalation rather than an engineering ticket.

**If the request is declined**, items 2, 3 and 5 stand unchanged and still deliver attribution and a
defensible review record. Item 4 degrades from a permission to a policy: reviewing agents are
instructed not to push, with no mechanism preventing it. The GitHub-native review property stays
unavailable. That fallback is Option E plus real attribution -- worse than the decision, strictly
better than today, and it is what we will operate.

## Trust boundaries

1. **Agent run to credential broker.** Crossed by a per-run capability token. The broker authorizes
   it against the run. Compromise yields the full installation cap for that run's lifetime.
2. **Broker to GitHub.** Crossed by an app private key exchanged for a token. We hold neither. This
   is the boundary we are least able to inspect, which is itself a reason to prefer few principals
   with tight caps over many with loose ones.
3. **Agent to repository contents.** Today a single boundary shared by all agents. Under this
   decision, two, with the sharper one on the reviewing side.
4. **Trailer to audit consumer.** **Trailers are self-asserted.** A commit message can claim any
   `Paperclip-Agent` value, and nothing in git prevents it. They are attribution, not
   authentication. A verifier must reconcile the trailer against the control plane's run record --
   agent id, run id, timestamp, pushed ref -- and must resolve an unreconcilable trailer to
   `unattributed`. Never to the claimed agent. Stating this in the record is the point: a trailer
   silently read as identity would be worse than having no trailer, because it would look like
   evidence.
5. **Fork boundary.** A forked deployment supplies its own broker and its own apps. Nothing in the
   trailer format or the `IdentityBroker` interface may name our installation, our app slug, our
   account, or our broker host.

## Blast radius: what breaks when the broker is unavailable

This is not hypothetical. The broker returned 401 for several agents earlier in this work queue
while resolving normally for others. The launcher's behaviour is written in its own source: on
401 or 403 it emits `capability_rejected`; on other failures, `broker_response_unavailable` or
`broker_transport_unavailable`. In every case it **continues without credentials rather than
failing**.

- `git` and `gh` still run. Public reads succeed. **Pushes fail at the network layer** -- loud, and
  safe.
- The launcher sets `user.useConfigOnly=true` with no identity, so `git commit` fails rather than
  inventing an author from the OS user. That is the right call: a commit with a guessed author is
  worse than no commit.
- The failure is **pre-write in every case**. No partial pushes, no half-written refs, no data loss.
  Recovery is a re-run.
- The genuine defect is that the degradation is nearly invisible to the agent's own reasoning. A
  single line on stderr is easy to read past, and an agent can plausibly report "pushed" on a run
  where nothing was pushed. Broker unavailability should surface as a first-class blocker on the
  issue, naming owner and action, rather than as a diagnostic line. Tracked separately; it is a
  reporting defect, not an identity defect, and it is already reachable today.
- Under this decision, an outage gets *directionally worse before better*: a reviewing agent whose
  broker call fails cannot record an approval, which stalls a merge instead of corrupting one. That
  is the failure direction to prefer.

## Consequences

**Positive.**

- Author-distinct review acquires a GitHub-native form, so the MCAA-281 class of deadlock stops
  recurring rather than being adjudicated per repository.
- "Which agent decided this" becomes answerable from the commit itself, reconciled against the
  control plane, instead of by correlating timestamps.
- A reviewing agent loses the ability to rewrite the CI it is reviewing against.
- We can answer a customer asking how our agents authenticate to their SCM and how to audit which
  agent did what, because we run the same mechanism we sell.

**Negative.**

- Two principals is coarser than per-agent. An agent's individual GitHub authorization is still not
  separable from its role's; only the trailer distinguishes it, and the trailer is not
  authentication.
- Trailers are permanent once pushed. A format mistake is not reversible in history, only
  superseded going forward. The format must be additive-tolerant from the first commit.
- Items 1 and 4 depend on a third party agreeing. We are choosing a decision we cannot fully
  execute alone, and saying so.
- All history to date stays attributed to `ryanmcafee`. We are not rewriting it, so the audit trail
  has a discontinuity at the date this lands. A record of that date is the mitigation.

**Neutral.**

- Trailers are additive; any consumer that does not parse them is unaffected. Git trailers are a
  documented commit-message convention, so existing tooling keeps working.
- Changing the principal changes the actor on future objects only.

## Compatibility and migration

- Do **not** enable a branch-protection rule requiring an approving review before item 1 lands.
  Doing so would re-create the MCAA-281 deadlock as a repository setting, where it is harder to
  adjudicate than as a policy question.
- The trailer set is versioned by being additive: consumers must ignore unknown `Paperclip-*`
  trailers, and a future field is added rather than a field redefined. A breaking change to the set
  requires a superseding record and a migration path, per the standing rule on schemas.
- `AgentIdentity` follows the same additive rule. `principalRef` is opaque to consumers; its shape
  is the broker implementation's business, which is what keeps a BYO broker from needing a fork.

## Compatibility tests

These do not exist yet. They are the acceptance criteria of the implementation work, named here so
the implementing engineer inherits them rather than inventing them. This record is `proposed`
pending a second reviewer, not pending these tests.

- `AgentIdentity` round-trips, and a payload carrying an unknown additional field still
  deserializes.
- A commit message carrying the three trailers parses back to the same agent id; a message carrying
  an unknown extra `Paperclip-*` trailer still parses; a message with no trailers yields
  `unattributed` and never a default agent.
- A trailer naming an agent id that does not match the control-plane run record resolves to
  `unattributed`, not to the claimed agent. This is the test that keeps boundary 4 honest.
- Role-to-principal selection is total, and an unrecognized role resolves to the least-privileged
  principal, never to `author`.

## Related

- MCAA-659 -- this record.
- MCAA-658 -- the immediate merge-authority ruling. Decision item 3 is the durable half of it.
- MCAA-281 -- the deadlock that surfaced the defect.
- MCAA-520 -- the second-reviewer policy bar that has no GitHub-native form today.
- MCAA-343 -- the shared working tree. The same class of defect: one shared resource where the
  design assumes one per agent.
