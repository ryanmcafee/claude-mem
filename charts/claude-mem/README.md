# claude-mem Helm chart

Runs claude-mem as a centralized memory server for agents:

- `server` Deployment and Service on port 37877, probed on `/healthz`.
- `worker` Deployment that consumes BullMQ generation jobs, with optional HPA or KEDA scaling.
- `migrate` Job that applies the Postgres schema once per install or upgrade, before any pod starts.

Postgres and Redis/Valkey are external. A dev-only Valkey can be bundled.

## Quick start

Prerequisites: `kubectl`, `helm` 3, `openssl`, and the
[CloudNativePG operator](https://cloudnative-pg.io/documentation/current/installation_upgrade/)
installed in the cluster, and a default StorageClass for the Postgres volume. Run the commands from
the repository root.

1. Create the namespace and the dependencies. The release reads the Postgres Secret from its own
   namespace, so the CloudNativePG `Cluster` must live in `$NS` and be Ready before install.
   `ci/fixtures/dependencies.yaml` is a trial setup: a one-instance `Cluster` named `pg` and an
   unauthenticated Valkey with `maxmemory-policy noeviction`, the same fixture CI installs against.

   ```sh
   NS=claude-mem
   kubectl create namespace "$NS"
   kubectl -n "$NS" apply -f charts/claude-mem/ci/fixtures/dependencies.yaml
   kubectl -n "$NS" wait cluster/pg --for=condition=Ready --timeout=10m
   kubectl -n "$NS" rollout status deploy/valkey --timeout=5m
   ```

   CloudNativePG then creates the `pg-app` Secret (`<cluster>-app` for a `Cluster` named `pg`).
   To use your own Valkey or Redis instead, see [Redis / Valkey](#redis--valkey); it must run with
   `maxmemory-policy noeviction` (`--maxmemory-policy noeviction` or `CONFIG SET maxmemory-policy noeviction`).

2. Create the bootstrap API keys. One raw key per entry; each entry name becomes the key name.

   ```sh
   kubectl -n "$NS" create secret generic claude-mem-api-keys \
     --from-literal=agent-a="cmem_$(openssl rand -hex 24)"
   ```

3. Install and wait for the pods to be Ready, then run the chart test.

   ```sh
   helm install claude-mem ./charts/claude-mem -n "$NS" --wait --timeout 10m \
     --set database.existingSecret=pg-app \
     --set redis.url=redis://valkey:6379 \
     --set auth.apiKeys.existingSecret=claude-mem-api-keys \
     --set tests.apiKeyName=agent-a

   helm test claude-mem -n "$NS" --logs
   ```

   The test prints `healthz=200 anonymous=401 authorized=200`. Without `--wait`, the test can run
   before the server is up and fail to connect.

4. Check it yourself. Read the bootstrapped key back out of the Secret; this is the value to give
   the agent. Every request except `/healthz` needs `Authorization: Bearer <key>`.

   ```sh
   KEY=$(kubectl -n "$NS" get secret claude-mem-api-keys -o jsonpath='{.data.agent-a}' | base64 -d)
   kubectl -n "$NS" port-forward svc/claude-mem 37877:37877 &
   until curl -s -o /dev/null http://127.0.0.1:37877/healthz; do sleep 1; done
   code() { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }
   code http://127.0.0.1:37877/healthz                                        # 200
   code http://127.0.0.1:37877/v1/usage                                       # 401
   code -H "Authorization: Bearer $KEY" http://127.0.0.1:37877/v1/usage       # 200
   ```

Agents running in another namespace cannot reach the server until that namespace is allowed by the
NetworkPolicy (see [Exposure](#exposure)). For example, for agents in namespace `agents`:

```sh
helm upgrade claude-mem ./charts/claude-mem -n "$NS" --reuse-values --wait \
  --set-string 'networkPolicy.allowedNamespaceLabels.kubernetes\.io/metadata\.name=agents'
```

Agents then use `http://claude-mem.<namespace>.svc:37877`.

Resource names in this README assume the release is named `claude-mem`. For any other release name
the Service is `<release>-claude-mem` and the server Deployment is `<release>-claude-mem-server`.

## Database

`database.existingSecret` is required.

| `database.mode` | Reads | Use when |
|---|---|---|
| `uri` (default) | `uriKey` (`uri`) | The Secret holds a full connection URL, as CloudNativePG's does. |
| `credentials` | `hostKey`, `portKey`, `dbnameKey`, `usernameKey`, `passwordKey` | The Secret holds separate fields. The URL is built without credentials and the user and password are passed as `PGUSER`/`PGPASSWORD`, so passwords never need URL-encoding. |

Set `database.sslMode` to `require` or `disable` to override the URL's `sslmode`.

## Redis / Valkey

Set exactly one of:

- `redis.url`: a plain URL with no credentials. The chart refuses a URL containing `@`.
- `redis.existingSecret` / `redis.urlKey`: the full `redis://` or `rediss://` URL.
- `valkey.enabled=true`: a single unpersisted Valkey. Queued jobs are lost on restart. Dev only.

`redis.queuePrefix` (default `claude_mem`) is the BullMQ key prefix.

## Migrations

`server migrate` runs in a Job annotated as a Helm `pre-install,pre-upgrade` hook and an ArgoCD
`PreSync` hook. Server and worker pods run with `CLAUDE_MEM_SERVER_SCHEMA_BOOTSTRAP=false`: they verify
the schema and refuse to start if it is missing, but never apply it. The migration takes a Postgres
advisory lock, so even an out-of-band rerun serializes rather than racing.

The Job does not use the chart's ServiceAccount, because on first install hooks run before it exists.
It mounts no Kubernetes API token.

## API keys

The chart runs `CLAUDE_MEM_AUTH_MODE=api-key` only. `auth.mode=local-dev` fails the render.

### Bootstrapped keys

`auth.apiKeys.existingSecret` names a Secret with one raw key per entry (minimum 32 characters).
After `server migrate`, the same Job runs `server api-key import`, which stores each key's SHA-256
hash. Every imported key gets `memories:read` and `memories:write`, and nothing else. Rerunning is
idempotent. Removing an entry from the Secret does **not** revoke the key; revoke it explicitly
(below). The import never re-enables a key that was revoked.

### Per-agent and per-tenant keys

Create additional keys with the server CLI inside a running server pod:

```sh
NS=claude-mem
SERVER="kubectl -n $NS exec deploy/claude-mem-server -- bun /opt/claude-mem/scripts/server-service.cjs"

# Key for the default team/project:
$SERVER server api-key create --name agent-b --scope memories:read,memories:write

# Key bound to a specific tenant:
$SERVER server api-key create --name tenant-x --team <team-id> --project <project-id> \
  --scope memories:read,memories:write

$SERVER server api-key revoke <key-id>
```

`create` prints JSON with `id`, `key`, `teamId` and `projectId`. The raw `key` is printed once:
store it in your secret manager, not in git. Record the `id` too; it is what `revoke` takes.

Without `--team`/`--project`, the key binds to the default team and project (named
`local-hook-team` / `local-hook-project`), and the output shows their ids. No CLI lists teams or
projects yet; read them from the `teams` and `projects` tables in Postgres.

`server api-key list --active` (and its alias `server keys`) currently fails against Postgres with
`column "last_used_at" does not exist`. Until that is fixed, the `create` output is the only place
to find a key id.

Do not create keys with `memories:write:shared` or `*`. A wildcard key can publish to shared scope,
and shared scope stays off until cross-tenant read redaction ships. The chart never mints either
scope and refuses `CLAUDE_MEM_INCLUDE_SHARED` in `extraEnv`.

## Generation provider credentials

`generation.existingSecret` holds one Secret with the same keys Paperclip uses:

| Key | Toggle | Default |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `generation.claudeCodeOAuthToken.enabled` | on (subscription) |
| `ANTHROPIC_API_KEY` | `generation.anthropicApiKey.enabled` | **off** (metered) |
| `OPENAI_API_KEY` | `generation.openaiApiKey.enabled` | **off** (metered) |

Only the worker receives provider credentials. The server and the migration Job never do. A metered
key reaches the worker only when its toggle is `true`, and `generation.provider` must match an
enabled key, or the render fails.

| `generation.provider` | Worker behavior |
|---|---|
| `claude-code` (default) | Receives `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_MEM_SERVER_PROVIDER=claude-code`, so it generates on the subscription. `ANTHROPIC_API_KEY` is stripped from that path. Without `generation.existingSecret`, generation stays disabled and the worker logs why. |
| `anthropic` | Generates with `ANTHROPIC_API_KEY`. |
| `openai` | Generates against `generation.openaiBaseUrl` (any OpenAI-compatible `/chat/completions` endpoint, e.g. LiteLLM at `http://litellm.litellm.svc:4000/v1`) using `OPENAI_API_KEY`. |

## Exposure

The default is a `ClusterIP` Service. A NetworkPolicy admits server traffic only from this release's
pods, from namespaces matching `networkPolicy.allowedNamespaceLabels`, pods matching
`networkPolicy.allowedPodLabels`, and any `networkPolicy.extraFrom` peers. Add your ingress
controller or gateway namespace there when exposing the server.

- Ingress: `ingress.enabled=true`; `ingress.clusterIssuer` adds `cert-manager.io/cluster-issuer`.
- Gateway API: `httpRoute.enabled=true` with `httpRoute.parentRefs`. TLS terminates on the Gateway
  listener; put the cert-manager annotation on the Gateway.

## Hardening

All containers run as UID/GID 1000, non-root, with a read-only root filesystem, no privilege
escalation, all capabilities dropped and `RuntimeDefault` seccomp. The writable paths are
`/data/claude-mem`, `/home/node/.claude`, `/home/node/.claude-mem` and `/tmp`, each backed by an
`emptyDir`. Pods spread across nodes and zones by default (`ScheduleAnyway`). PodDisruptionBudgets
cover the server (when it has more than one replica) and the worker.

## Worker scaling

- `worker.autoscaling.enabled`: CPU-based HPA.
- `worker.keda.enabled`: KEDA `ScaledObject` on the BullMQ waiting lists
  (`<queuePrefix>:server_beta_generate_event:wait` and `...summary:wait`). Set `worker.keda.address`
  (`host:port`) and, if Redis needs a password, `worker.keda.passwordSecret`. Requires KEDA CRDs.

The two are mutually exclusive.

## ArgoCD

Point an `Application` at this chart with your values. The migration Job runs in `PreSync`, so
server and worker pods roll only after the schema is in place. A failed migration fails the sync and
leaves the running pods untouched.

## Versioning

The chart `version` follows SemVer and is bumped on every chart change (`ct lint` enforces it).
`appVersion` is the image tag the chart defaults to (`sha-<7 chars>` from main, or `X.Y.Z` from a
release). Pin `image.digest` in production.

## Rollback

`helm rollback <release> <revision>` restores the previous manifests. It does not rerun the
migration Job (no `pre-rollback` hook), and schema changes are not reverted: the migration is idempotent and only moves
forward, so check the release notes before rolling back across a schema version. Imported keys stay
until revoked.
