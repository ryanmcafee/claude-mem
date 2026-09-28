# Worker To Server Migration

Claude-Mem 13 keeps the worker path in place. Server beta is an additional runtime option for teams, deployable containers, API keys, and BullMQ/Valkey queues.

Compatibility commands remain available:

```sh
claude-mem start
claude-mem worker start
claude-mem server start
```

The server storage boundary reads legacy worker data while adding server-owned projects, sessions, agent events, memory items, teams, API keys, and audit logs. Migrate adapters gradually by writing to `/v1/events` and `/v1/memories`; keep existing `/api/*` hook routes enabled until all clients move.

## Importing an existing local database

`claude-mem import` copies the observations and session summaries out of a local
SQLite database and into the central server over `/v1/memories`. It is safe to
re-run: every row is sent with a deterministic idempotency key derived from its
table, local session id and row id, and the server refuses to store the same key
twice within a tenant. A second run reports the rows as already present and
changes nothing.

**The import adds rows; it does not sync them.** The key is derived from row
identity and never from content, so the server answers a repeat with "already
present" without comparing what the row now says. If you edit or regenerate a
local observation after importing it, re-running the import will not carry that
change across — the first version imported is the one the server keeps. Treat the
import as a one-way move onto the central store, not as ongoing replication.

```sh
export CLAUDE_MEM_SERVER_URL=https://claude-mem.example.com
export CLAUDE_MEM_API_KEY=cm_...          # the API key IS the tenant binding
export CLAUDE_MEM_PROJECT_ID=proj-homelab # every imported row is scoped to it
export CLAUDE_MEM_AGENT_ID=laptop         # optional, recorded on each row

claude-mem import --dry-run   # what would be sent
claude-mem import             # send it
claude-mem import             # proves it: imported 0, already present N
```

Options:

| Flag | Effect |
| --- | --- |
| `--database <path>` | Source database (default: the local `claude-mem.db`) |
| `--project <id>` | Central project id, overriding `CLAUDE_MEM_PROJECT_ID` |
| `--agent <id>` | Agent identity recorded on every imported row |
| `--source-project <name>` | Only rows whose local project matches; repeatable |
| `--dry-run` | Report the plan without writing |

Notes:

- There are no unscoped rows. The project id is required, the team comes from
  the API key server-side, and the local project name and session id are kept in
  each row's metadata as provenance.
- The source database is opened read-only, so an import never creates or
  modifies local state.
- Per-row failures (an unreachable server, a rejected row) are counted and
  reported, and the command exits non-zero. Fix the cause and re-run; the rows
  that did land are not duplicated.
- Imported rows carry `metadata.source = "sqlite-import"`, which is how you tell
  imported memory from memory the server generated itself.

Backup and restore for the central store is documented separately in
[postgres-backup-restore.md](postgres-backup-restore.md).
