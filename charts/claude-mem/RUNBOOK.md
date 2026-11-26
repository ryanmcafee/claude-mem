# claude-mem alert runbook

Each alert in `templates/prometheusrule.yaml` links to its section here. The commands assume
`NS` is the release namespace and `RELEASE` the Helm release name.

```bash
NS=claude-mem RELEASE=claude-mem
```

The Grafana dashboard (`metrics.dashboard.enabled`) has a top row that answers "is anyone
affected right now?". Open it first.

## ClaudeMemServerDown

**Impact:** agents cannot read or write memory. Severity critical.

**Fires when:** no server target for the release has answered a scrape for
`metrics.prometheusRule.serverDown.for` (default 5m), or none was ever discovered.

1. `kubectl -n $NS get pods -l app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=server`
2. Pods missing or `Pending`: `kubectl -n $NS describe pod <pod>` and read the events. No node fits
   the requests, or an image pull failed.
3. `CrashLoopBackOff`: `kubectl -n $NS logs <pod> --previous`. A database or Redis error means the
   Secret in `database.existingSecret` / `redis.existingSecret` is wrong or the backend is down.
   Check the CloudNativePG cluster with `kubectl -n $NS get cluster`.
4. Pods `Running` but the alert still fires: Prometheus cannot reach port `metrics`. Check
   `metrics.allowedNamespaceLabels` against your Prometheus namespace, and check that
   `metrics.serviceMonitor.enabled=true`.
5. If a rollout started this, `helm -n $NS rollback $RELEASE`.

## ClaudeMemQueueBacklogGrowing

**Impact:** memories are stored, but the observations generated from them are delayed. Severity warning.

**Fires when:** one lane has more than `queueBacklog.threshold` (default 100) waiting jobs and the
count has not fallen over 10m, sustained for `queueBacklog.for` (default 15m).

1. `kubectl -n $NS get pods -l app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=worker`
2. No worker running: scale it back (`worker.replicaCount`), or fix its crash from the logs.
3. Workers running but `ClaudeMemGenerationFailureRatio` also firing: the provider is failing.
   Follow that section.
4. Workers running and succeeding: throughput is too low. Raise `worker.replicaCount`, or enable
   `worker.keda` to scale on queue length.

## ClaudeMemGenerationFailureRatio

**Impact:** memories are stored but are not turned into observations. Retries may also burn
provider quota. Severity warning.

**Fires when:** more than `generationFailures.threshold` (default 25%) of generation attempts
failed over `generationFailures.window`, with at least `minAttempts` attempts in the window,
sustained for `generationFailures.for`.

Break the failures down by reason:

```promql
sum by (reason) (rate(claude_mem_generation_attempts_total{namespace="$NS", outcome="failed"}[15m]))
```

| reason | action |
|---|---|
| `auth_invalid`, `quota_exhausted` | Rotate or top up the key in `generation.existingSecret`, then `kubectl -n $NS rollout restart deploy/$RELEASE-claude-mem-worker`. |
| `rate_limit`, `transient` | The provider is throttling or degraded. Reduce worker replicas, or wait and watch the ratio fall. |
| `parse_error` | The model answers in the wrong shape. Check `generation.model`, and raise `generation.maxOutputTokens` if responses are truncated. |
| `scope_mismatch`, `revoked_key` | The job was refused on purpose. A burst means a key was revoked while its jobs were queued; check the audit log. |
| `unknown` | Read the worker logs for `observation generator failed`. |

## ClaudeMemHttpErrorRatio

**Impact:** agents get server errors on memory reads or writes. Severity critical.

**Fires when:** more than `httpErrors.threshold` (default 5%) of API requests returned 5xx over
`httpErrors.window`, with at least `minRequests` requests in the window. Probes are excluded.

1. Find the failing routes:
   ```promql
   sum by (route, status_code) (rate(claude_mem_http_requests_total{namespace="$NS", status_code=~"5.."}[5m]))
   ```
2. Every route failing usually means Postgres is unreachable. Check
   `kubectl -n $NS get cluster` and the database Secret.
3. A single route failing: read the server logs for that path:
   `kubectl -n $NS logs deploy/$RELEASE-claude-mem-server | grep <route>`.
4. If a rollout started this, `helm -n $NS rollback $RELEASE`.

## Silencing

Silence only for a bounded window with a reason (for example, a planned database maintenance),
and record the reason in the incident or change ticket. Never silence to make a dashboard green.
