# Paperclip agent against a remote claude-mem

A Paperclip agent (or any Claude Code / OpenClaw install) needs two things: the
environment that puts claude-mem in remote mode, and an MCP entry so the agent
can recall memory as a tool. No worker runs and no database file is created, so
the agent container stays stateless.

## 1. Environment

Give the agent one API key per tenant. The key is the tenant binding — an agent
holding tenant A's key cannot read tenant B's rows even if it knows B's project
id.

```bash
CLAUDE_MEM_SERVER_URL=https://claude-mem.example.com
CLAUDE_MEM_API_KEY=cm_...              # from a Paperclip secret, never inline
CLAUDE_MEM_PROJECT_ID=homelab
CLAUDE_MEM_AGENT_ID=senior-app-engineer  # optional, recorded on every write
```

Under Kubernetes, take the key from a secret rather than the manifest:

```yaml
env:
  - name: CLAUDE_MEM_SERVER_URL
    value: https://claude-mem.example.com
  - name: CLAUDE_MEM_PROJECT_ID
    value: homelab
  - name: CLAUDE_MEM_AGENT_ID
    valueFrom:
      fieldRef:
        fieldPath: metadata.labels['app.kubernetes.io/instance']
  - name: CLAUDE_MEM_API_KEY
    valueFrom:
      secretKeyRef:
        name: claude-mem-api-key   # managed by External Secrets
        key: apiKey
```

Nothing in this block is specific to one operator: the host, project and key all
come from inputs, so a fork sets its own three values and is done.

## 2. MCP configuration

The server exposes an authenticated streamable-HTTP MCP endpoint at `/v1/mcp`
with the read tools `search`, `context` and `recent`.

```bash
claude mcp add --transport http claude-mem \
  "$CLAUDE_MEM_SERVER_URL/v1/mcp" \
  --header "Authorization: Bearer $CLAUDE_MEM_API_KEY"
```

Or declare it, for an agent whose MCP config is a file:

```json
{
  "mcpServers": {
    "claude-mem": {
      "type": "http",
      "url": "https://claude-mem.example.com/v1/mcp",
      "headers": {
        "Authorization": "Bearer ${CLAUDE_MEM_API_KEY}"
      }
    }
  }
}
```

Keep the key in an env reference. A literal key in a committed MCP config is a
credential in source control.

## 3. Reading shared knowledge

By default the agent recalls only its own tenant. To let it reach cross-tenant
knowledge, either pass the scope per call:

```jsonc
{ "projectId": "homelab", "query": "argocd rollback", "scope": "shared" }
```

or make shared the default for this agent:

```bash
CLAUDE_MEM_INCLUDE_SHARED=1
```

Publishing into the shared scope is a separate grant — mint that agent's key
with `memories:write:shared`. Without it a `shared: true` write is rejected with
a `403` rather than silently landing team-private.

## 4. Confirming remote mode

Remote mode is working when all three hold:

```bash
# 1. The server answers.
curl -sS -o /dev/null -w '%{http_code}\n' "$CLAUDE_MEM_SERVER_URL/healthz"

# 2. No worker process.
pgrep -f worker-service || echo "no local worker (expected)"

# 3. No local database.
test -e "${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}/claude-mem.db" \
  && echo "UNEXPECTED local database" \
  || echo "no local database (expected)"
```

A misconfiguration fails loudly: if `CLAUDE_MEM_SERVER_URL` is set but the key
or project id is missing, the client raises an error naming the missing variable
instead of falling back to a local worker.
