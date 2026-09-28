# Architecture decision records

A decision that is not written here has not been made. Each record states the
context, the options that were considered, the decision, and the consequences a
future reader has to live with — enough that a stranger could defend the
decision without its author in the room.

Records are append-only. Revisit a decision by adding a new record that
supersedes the old one; do not rewrite history in place.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](./0001-remote-client-mode-and-shared-scope.md) | Remote client mode, tenant binding and opt-in shared scope | Accepted (arrives with PR #6; link is dead until it merges) |
| [0002](./0002-remote-corpus-api-and-mcp-contract.md) | Remote corpus (knowledge-base) API and MCP contract | Accepted (rev 7, second reviews applied) |

A number belongs to one record. ADR 0002 was authored as `0001` on an unmerged
branch and renumbered; MCAA-260's branch (PR #7) still carries a stale revision-2
copy at `0001-remote-corpus-api-and-mcp-contract.md`, which it deletes before merge
(ADR 0002, condition 19). Citations of `0001-remote-corpus-api-and-mcp-contract.md`
mean ADR 0002.
