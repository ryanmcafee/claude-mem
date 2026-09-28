# Remote client mode

Point claude-mem at a centrally hosted server instead of a local worker. No
worker process is spawned and no local database is created. The API key is the
tenant binding: the server derives the team from it and refuses to return
another tenant's rows, whatever the client asks for.

Four integrations are covered here, each runnable:

| Example | For | Run |
| --- | --- | --- |
| [`paperclip-agent.md`](./paperclip-agent.md) | A Paperclip agent, or any Claude Code / OpenClaw install | Config only |
| [`mcp-client.ts`](./mcp-client.ts) | Any MCP client over streamable HTTP | `bun examples/remote-mode/mcp-client.ts` |
| [`http-client.ts`](./http-client.ts) | Any language, plain HTTP | `bun examples/remote-mode/http-client.ts` |
| [`corpus-client.ts`](./corpus-client.ts) | Building and querying a knowledge corpus | `bun examples/remote-mode/corpus-client.ts` |

## Environment contract

Every surface reads the same variables. The environment wins over
`~/.claude-mem/settings.json`, so a container needs no settings file at all.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CLAUDE_MEM_SERVER_URL` | yes | Base URL of the server, e.g. `https://claude-mem.example.com`. **Setting this in the environment enables remote mode.** |
| `CLAUDE_MEM_API_KEY` | yes | API key. This is the tenant binding — the server resolves the team from it. |
| `CLAUDE_MEM_PROJECT_ID` | yes | Project every write is recorded under. |
| `CLAUDE_MEM_AGENT_ID` | no | Agent identity recorded on each write, alongside team and project. |
| `CLAUDE_MEM_INCLUDE_SHARED` | no | `1`/`true` makes reads default to the shared scope. Off by default. |
| `CLAUDE_MEM_RUNTIME` | no | Set to `remote` to assert remote mode before the URL is known, so a misconfigured pod fails loudly. |

`CLAUDE_MEM_SERVER_API_KEY` and `CLAUDE_MEM_SERVER_PROJECT_ID` are accepted as
legacy aliases.

### What triggers remote mode

An environment `CLAUDE_MEM_SERVER_URL`, or `CLAUDE_MEM_RUNTIME=remote` from
either source. A server URL in `settings.json` alone does **not** — the older
`CLAUDE_MEM_RUNTIME=server` runtime stores its address under that same key and
is specified to fall back to the local worker when under-configured, so treating
that file as a trigger would turn every existing server-runtime install into a
hard error. Configuring remote mode from a settings file therefore needs
`CLAUDE_MEM_RUNTIME=remote` in it as well. Containers are unaffected: they set
env vars, which trigger on their own.

Remote mode never falls back. If the URL is set but the key or project is
missing, the client raises an error naming the missing variable rather than
quietly writing to a local SQLite file nobody reads.

## Scopes

A read returns your own tenant's rows unless it asks for the shared scope by
name:

```jsonc
{ "projectId": "homelab", "query": "argocd rollback" }                    // your tenant only
{ "projectId": "homelab", "query": "argocd rollback", "scope": "shared" } // plus shared knowledge
```

Both paths fail closed on an unrecognised value: the REST endpoints answer `400`
and the MCP tools narrow to your own tenant. Neither widens a read.

Publishing into the shared scope is a separate grant. A write with
`"shared": true` needs `memories:write:shared` on the API key; a key with plain
`memories:write` gets a `403` instead of silently writing team-private:

```bash
curl -sS -X POST "$CLAUDE_MEM_SERVER_URL/v1/memories" \
  -H "Authorization: Bearer $CLAUDE_MEM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"homelab","content":"Rollbacks use the previous ArgoCD revision.","shared":true}'
```

## API surface

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/memories` | Write an observation. Accepts `shared`. |
| `POST /v1/search` | Full-text search. Accepts `scope`. |
| `POST /v1/context` | Search plus a pre-joined `context` string for prompt injection. |
| `POST /v1/events` | Record an agent event and enqueue observation generation. |
| `POST`/`GET /v1/mcp` | Streamable-HTTP MCP endpoint exposing `search`, `context`, `recent` and the corpus tools. |
| `POST /v1/projects/:projectId/corpora` | Build a knowledge corpus, or rebuild one in place. Accepts `shared`. |
| `GET /v1/projects/:projectId/corpora` | List corpora. Accepts `scope`. |
| `GET /v1/projects/:projectId/corpora/:name` | Corpus metadata; `?include=sources` adds the member observations. |
| `POST /v1/projects/:projectId/corpora/:name/{rebuild,prime,reprime,query}` | Refresh, materialise, invalidate, ask. |
| `DELETE /v1/projects/:projectId/corpora/:name` | Delete a corpus. Member observations are untouched. |
| `GET /v1/corpora/:corpusId` and `POST /v1/corpora/:corpusId/query` | Read a corpus another tenant published. Read-only. |
| `GET /healthz` | Liveness. |

Every read is scoped by the key's team server-side and written to the audit log
with the scope that was used.

## Knowledge corpora

A corpus is a named, filtered set of observations you can ask questions of. The
tool names are the same in both modes (`build_corpus`, `list_corpora`,
`prime_corpus`, `query_corpus`, `rebuild_corpus`, `reprime_corpus`, plus
`get_corpus` and `delete_corpus` remotely), so a skill transfers unchanged. Three
behaviours differ from the local worker and the difference is deliberate:

- **Membership is by reference.** Deleting or un-sharing an observation removes
  it from every corpus that held it, and the corpus's `observationCount` falls.
  A corpus is not a frozen snapshot; record observation ids yourself if you need
  a citation that cannot move.
- **Priming is deterministic and optional.** `prime_corpus` renders the member
  set and caches it under a content digest; it calls no model. `query_corpus`
  renders on demand when nothing is cached, so a read-only key never meets a
  "not primed" error. A cached render is served only while its digest still
  matches live membership.
- **There is no server-side conversation.** Each `query_corpus` call is
  independent. Pass prior turns in `history` for a follow-up. `reprime_corpus`
  is cache invalidation, not "clear the drifted conversation" — there is none to
  clear.

`build_corpus` filter arguments also differ: the remote server takes `kinds` (an
array), `metadataMatch` (JSON containment) and `dateStartEpoch`/`dateEndEpoch`
(epoch ms) where the local tool takes `types`, `concepts`/`files` and ISO
`dateStart`/`dateEnd`. Passing a local-only argument fails loudly and names the
substitute rather than returning a plausible, wrong corpus.

A `scope: "shared"` filter selects other tenants' shared observations, so it
cannot also filter on `metadataMatch` or `platformSource`: those test attributes
a shared row never discloses to you, and the resulting `observationCount` would
answer the question the response withholds. The combination is `400` from the
schema and the server alike. Filter on `kinds`, `query` or the date bounds, or
use `scope: "project"` to filter your own observations on metadata.

Publishing a corpus needs `memories:write:shared`, exactly like publishing an
observation — and a shared corpus may contain **only** observations that are
themselves shared. A build or rebuild that would include a private row is
refused with `422 SharedCorpusPrivateMembers` and the disqualifying count; it is
never silently filtered down or downgraded to private.

### What a published corpus gives another tenant

Publishing a corpus shares content, not provenance, on the same rule a shared
observation read follows. Reading a corpus you do not own (`foreign: true`) omits
the corpus's `projectId`, and each `?include=sources` row omits `projectId` and
`metadata` — `projects.id` is caller-supplied text, usually a repository or
directory name, and `metadata` is publisher-controlled JSON that the write path
stamps with the publishing agent's id. `query_corpus` answers the same way: the
rendered text a foreign reader is answered from carries no metadata, and a render
cached by the owner's `prime_corpus` is never served across the boundary. Reading
your own corpus is unaffected.

Two ceilings apply at build and rebuild, each with a `reason` so you know which
fix applies: more than 2000 matched rows is `422 CorpusTooLarge`
(`reason: "members"` — narrow the filter), and a render over 400,000 estimated
tokens is `422 CorpusTooLarge` (`reason: "tokens"` — reduce the content volume).
Below the ceiling, `limit` truncation is legitimate and always reported through
`matchedCount` and `truncated`.

Answering a question is the one corpus operation that calls a model, so the
server needs `CLAUDE_MEM_SERVER_PROVIDER` and the matching API key configured.
Everything else — build, list, get, prime, reprime, delete — is pure SQL and a
deterministic render.
