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
- Name the titles, never a test count. A count is a property of the instrument that produced it, not
  of the file: a `^\s*it\(` grep and an AST walk disagree on the same revision because the grep
  cannot see `it.skip(...)` or a currying `it.each(...)`. A record that fixes a number sends its next
  reader to verify a figure their tool reports differently, which reads as a discrepancy and is not
  one. Titles are what the `dropped-test guard (gated suites)` job compares, so they are also what
  the machine will hold you to.
- This index carries the title and the status, never a revision number and never the state of a
  branch that has not merged. A revision belongs in its own record's header, and a branch state is
  true for hours: an index row that pins either is wrong at the next amendment or the next push,
  three unmerged branches can each create this file with a different answer, and nothing reads prose
  for drift. Write only what stays true whichever of them merges first.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](./0001-remote-client-mode-and-shared-scope.md) | Remote client mode, tenant binding and opt-in shared scope | accepted |
| [0002](./0002-remote-corpus-api-and-mcp-contract.md) | Remote corpus (knowledge-base) API and MCP contract | accepted |
| [0003](./0003-client-supplied-idempotency-key-on-v1-memories.md) | A client-supplied idempotency key on `POST /v1/memories` | accepted |

Each record reaches `main` with its own pull request, so a link above can be dead in a branch that
does not yet carry that record, and two unmerged branches can hold different revisions of the same
record until both have landed. ADR 0002 was authored as `0001` on an unmerged branch and renumbered;
that duplicate was deleted at `e2c3bc38`, so only one file claims each number and ADR 0002's
condition 19 is satisfied. Citations of `0001-remote-corpus-api-and-mcp-contract.md` mean ADR 0002.
