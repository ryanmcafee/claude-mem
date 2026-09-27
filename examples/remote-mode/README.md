# Remote client mode

Point claude-mem at a centrally hosted server instead of a local worker. No
worker process is spawned and no local database is created. The API key is the
tenant binding: the server derives the team from it and refuses to return
another tenant's rows, whatever the client asks for.

Three integrations are covered here, each runnable:

| Example | For | Run |
| --- | --- | --- |
| [`paperclip-agent.md`](./paperclip-agent.md) | A Paperclip agent, or any Claude Code / OpenClaw install | Config only |
| [`mcp-client.ts`](./mcp-client.ts) | Any MCP client over streamable HTTP | `bun examples/remote-mode/mcp-client.ts` |
| [`http-client.ts`](./http-client.ts) | Any language, plain HTTP | `bun examples/remote-mode/http-client.ts` |

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
| `POST`/`GET /v1/mcp` | Streamable-HTTP MCP endpoint exposing `search`, `context`, `recent`. |
| `GET /healthz` | Liveness. |

Every read is scoped by the key's team server-side and written to the audit log
with the scope that was used.
