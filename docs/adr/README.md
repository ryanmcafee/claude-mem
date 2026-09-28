# Architecture decision records

A decision that is not written here has not been made. Every decision that crosses a service or
trust boundary is recorded here before it is considered made. Each record states the context, the
options that were considered, the decision, and the consequences a future reader has to live with --
enough that a stranger could defend the decision without its author in the room.

Conventions:

- Files are `NNNN-kebab-case-title.md`, numbered in the order they are accepted.
- Status is one of `proposed`, `accepted`, `superseded by NNNN`, or `rejected`.
- Records are append-only. Revisit a decision by adding a record that supersedes the old one;
  records are never edited to hide a decision that was actually taken.
- A number belongs to one record, permanently.
- A record that changes a wire contract or a schema names its compatibility tests. Name the test,
  not only the file, when the same file also carries tests this decision does not own: a merge or a
  harness rewrite can delete an assertion while the file keeps passing and the workflow keeps
  naming it, and a list of filenames cannot tell you that happened.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](./0001-remote-client-mode-and-shared-scope.md) | Remote client mode, tenant binding and opt-in shared scope | accepted |
| [0002](./0002-remote-corpus-api-and-mcp-contract.md) | Remote corpus (knowledge-base) API and MCP contract | accepted |
| [0003](./0003-client-supplied-idempotency-key-on-v1-memories.md) | A client-supplied idempotency key on `POST /v1/memories` | accepted |

Each record reaches `main` with its own pull request, so a link above can be dead in a branch that
does not yet carry that record. ADR 0002 was authored as `0001` on an unmerged branch and
renumbered; MCAA-260's branch (PR #7) still carries a stale revision-2 copy at
`0001-remote-corpus-api-and-mcp-contract.md`, which it deletes before merge (ADR 0002, condition 19).
Citations of `0001-remote-corpus-api-and-mcp-contract.md` mean ADR 0002.
