#!/usr/bin/env bash
# Kind acceptance for the chart: install then upgrade against CloudNativePG + Valkey,
# proving one migration run per revision and no metered key in the worker.
set -euo pipefail

NAMESPACE=${NAMESPACE:-claude-mem-ci}
RELEASE=${RELEASE:-acceptance}
CHART=${CHART:-charts/claude-mem}
IMAGE_ARGS=(--set image.repository="${IMAGE_REPOSITORY:?}" --set image.tag="${IMAGE_TAG:?}" --set image.pullPolicy=Never)
VALUES=(-f "$CHART/ci/cnpg-uri-values.yaml")
WORKER="$RELEASE-claude-mem-worker"
JOB="$RELEASE-claude-mem-migrate"

fail() { echo "ACCEPTANCE FAILED: $*" >&2; exit 1; }

migration_rows() {
  kubectl -n "$NAMESPACE" exec pg-1 -c postgres -- \
    psql -U postgres -d app -tAc 'SELECT count(*) FROM server_beta_schema_migrations'
}

assert_one_migration_run() {
  local revision=$1 succeeded logs
  succeeded=$(kubectl -n "$NAMESPACE" get job "$JOB" -o jsonpath='{.status.succeeded}')
  [[ "$succeeded" == 1 ]] || fail "revision $revision: migrate Job succeeded=$succeeded, want 1"
  logs=$(kubectl -n "$NAMESPACE" logs "job/$JOB" -c migrate)
  grep -q '"status": "migrated"' <<<"$logs" || fail "revision $revision: migrate output missing: $logs"
  echo "revision $revision: migrate Job ran once: $(tr -d '\n ' <<<"$logs")"
}

helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" "${VALUES[@]}" "${IMAGE_ARGS[@]}" --wait --timeout 10m
assert_one_migration_run 1

helm upgrade "$RELEASE" "$CHART" -n "$NAMESPACE" "${VALUES[@]}" "${IMAGE_ARGS[@]}" --set podAnnotations.rollout=2 --wait --timeout 10m
assert_one_migration_run 2

rows=$(migration_rows)
[[ "$rows" == 1 ]] || fail "server_beta_schema_migrations has $rows rows, want 1"
echo "schema version rows: $rows"

for deploy in "$RELEASE-claude-mem-server" "$WORKER"; do
  restarts=$(kubectl -n "$NAMESPACE" get pods -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=${deploy##*-}" \
    -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' | sort -u | tr '\n' ' ')
  [[ "$restarts" == "0 " ]] || fail "$deploy pods restarted: $restarts"
done

env_names=$(kubectl -n "$NAMESPACE" get deploy "$WORKER" -o jsonpath='{range .spec.template.spec.containers[*].env[*]}{.name}{"\n"}{end}')
for metered in ANTHROPIC_API_KEY OPENAI_API_KEY CLAUDE_MEM_OPENROUTER_API_KEY CLAUDE_MEM_ANTHROPIC_API_KEY; do
  grep -qx "$metered" <<<"$env_names" && fail "worker env carries $metered with default generation values"
done
live_env=$(kubectl -n "$NAMESPACE" exec "deploy/$WORKER" -- env | cut -d= -f1)
for metered in ANTHROPIC_API_KEY OPENAI_API_KEY; do
  grep -qx "$metered" <<<"$live_env" && fail "running worker has $metered set"
done
echo "worker env: no metered API key"

scopes=$(kubectl -n "$NAMESPACE" exec pg-1 -c postgres -- \
  psql -U postgres -d app -tAc "SELECT DISTINCT scopes::text FROM api_keys WHERE actor_id = 'system:server-api-key-import'")
[[ "$scopes" == '["memories:read", "memories:write"]' ]] || fail "imported key scopes: $scopes"
echo "imported key scopes: $scopes"

helm test "$RELEASE" -n "$NAMESPACE" --logs
helm uninstall "$RELEASE" -n "$NAMESPACE" --wait
echo "ACCEPTANCE PASSED"
