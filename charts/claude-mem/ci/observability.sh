#!/usr/bin/env bash
# Kind verification for metrics, alerts and dashboard: scrape a running server and worker through
# kube-prometheus-stack, fire every alert deliberately, and query every dashboard panel via Grafana.
set -euo pipefail

NAMESPACE=${NAMESPACE:-claude-mem-ci}
MONITORING=${MONITORING:-monitoring}
RELEASE=${RELEASE:-obs}
CHART=${CHART:-charts/claude-mem}
KPS_VERSION=${KPS_VERSION:-93.10.1}
IMAGE="${IMAGE_REPOSITORY:?}:${IMAGE_TAG:?}"
IMAGE_ARGS=(--set image.repository="$IMAGE_REPOSITORY" --set image.tag="$IMAGE_TAG" --set image.pullPolicy=Never)
FULLNAME="$RELEASE-claude-mem"
PROM=http://127.0.0.1:9090
GRAFANA=http://127.0.0.1:3000
ALERTMANAGER=http://127.0.0.1:9093
API=http://127.0.0.1:37877
PIDS=()

dump_prometheus() {
  local query
  echo "== Prometheus state at failure" >&2
  for query in 'claude_mem_generation_attempts_total' 'claude_mem_queue_jobs' 'up' \
    'sum(rate(claude_mem_generation_attempts_total{outcome="failed"}[2m]))' \
    'sum(increase(claude_mem_generation_attempts_total[2m]))'; do
    echo "-- $query" >&2
    curl -sS "$PROM/api/v1/query" --data-urlencode "query=$query" \
      | jq -c '.data.result[]? | {metric, value}' >&2 || true
  done
  echo "-- rules" >&2
  curl -sS "$PROM/api/v1/rules" \
    | jq -c '.data.groups[]? | .rules[] | {name, state, health, lastError}' >&2 || true
  echo "-- worker /metrics" >&2
  kubectl -n "$NAMESPACE" exec "deploy/$FULLNAME-worker" -- curl -sS http://127.0.0.1:9464/metrics 2>&1 \
    | grep claude_mem_generation >&2 || true
  echo "-- generation jobs by status" >&2
  kubectl -n "$NAMESPACE" exec pg-1 -c postgres -- psql -U postgres -d app -tAc \
    "SELECT status, attempts, left(coalesce(last_error::text, ''), 120), count(*) FROM observation_generation_jobs GROUP BY 1, 2, 3" \
    >&2 || true
}

fail() { echo "OBSERVABILITY FAILED: $*" >&2; dump_prometheus; exit 1; }
cleanup() { for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

forward() {
  kubectl -n "$1" port-forward "$2" "$3" >/dev/null 2>&1 &
  PIDS+=($!)
}

# wait_for <description> <seconds> <command...>: retry the command every 10s until it succeeds.
wait_for() {
  local what=$1 budget=$2 deadline
  shift 2
  deadline=$((SECONDS + budget))
  until "$@"; do
    (( SECONDS < deadline )) || fail "timed out after ${budget}s waiting for $what"
    sleep 10
  done
  echo "ok: $what"
}

prom_value() {
  curl -fsS "$PROM/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // empty'
}

prom_at_least() {
  local value
  value=$(prom_value "$1")
  [[ -n "$value" ]] && awk -v v="$value" -v min="$2" 'BEGIN { exit !(v + 0 >= min + 0) }'
}

alert_firing() {
  curl -fsS "$PROM/api/v1/alerts" \
    | jq -e --arg name "$1" '.data.alerts[] | select(.labels.alertname == $name and .state == "firing")' >/dev/null
}

alertmanager_has() {
  curl -fsS "$ALERTMANAGER/api/v2/alerts?active=true" \
    | jq -e --arg name "$1" '.[] | select(.labels.alertname == $name)' >/dev/null
}

# Alertmanager drops an alert once it resolves, so confirm delivery while it is still firing.
expect_delivered() {
  wait_for "$1 delivered to Alertmanager" 120 alertmanager_has "$1"
  curl -fsS "$ALERTMANAGER/api/v2/alerts?active=true" | jq -c --arg name "$1" \
    '.[] | select(.labels.alertname == $name) | {alertname: .labels.alertname, severity: .labels.severity, startsAt, summary: .annotations.summary}'
}

post_events() {
  local count=$1 i
  for ((i = 0; i < count; i++)); do
    curl -fsS -o /dev/null -X POST "$API/v1/events" \
      -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
      -d "{\"projectId\":\"$PROJECT_ID\",\"sourceType\":\"api\",\"eventType\":\"observation.created\",\"payload\":{\"ci\":$i},\"occurredAtEpoch\":$(date +%s000)}"
  done
}

restart_api_forward() {
  forward "$NAMESPACE" "svc/$FULLNAME" 37877:37877
  wait_for "server API port-forward" 60 curl -fsS -o /dev/null "$API/healthz"
}

echo "== kube-prometheus-stack $KPS_VERSION"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm upgrade --install kps prometheus-community/kube-prometheus-stack --version "$KPS_VERSION" \
  -n "$MONITORING" --create-namespace -f "$CHART/ci/fixtures/kube-prometheus-stack.yaml" --wait --timeout 10m

echo "== mock provider and release with ServiceMonitor, PrometheusRule and dashboard"
kubectl -n "$NAMESPACE" create secret generic ci-mock-generation --from-literal=OPENAI_API_KEY=mock-not-a-key \
  --dry-run=client -o yaml | kubectl apply -f -
sed "s|__IMAGE__|$IMAGE|" "$CHART/ci/fixtures/mock-provider.yaml" | kubectl -n "$NAMESPACE" apply -f -
kubectl -n "$NAMESPACE" rollout status deploy/mock-provider --timeout=5m
helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$CHART/ci/cnpg-uri-values.yaml" \
  -f "$CHART/ci/fixtures/observability.yaml" "${IMAGE_ARGS[@]}" --wait --timeout 10m

forward "$MONITORING" svc/kps-prometheus 9090:9090
forward "$MONITORING" svc/kps-alertmanager 9093:9093
forward "$MONITORING" svc/kps-grafana 3000:80
restart_api_forward
wait_for "Prometheus API" 120 curl -fsS -o /dev/null "$PROM/-/ready"

API_KEY=$(kubectl -n "$NAMESPACE" get secret agent-keys -o jsonpath='{.data.ci}' | base64 -d)
PROJECT_ID=$(kubectl -n "$NAMESPACE" exec pg-1 -c postgres -- psql -U postgres -d app -tAc \
  "SELECT project_id FROM api_keys WHERE actor_id = 'system:server-api-key-import' AND revoked_at IS NULL LIMIT 1")
[[ -n "$PROJECT_ID" ]] || fail "no project for the imported CI key"

SERVER="namespace=\"$NAMESPACE\", job=\"$FULLNAME\""
WORKER="namespace=\"$NAMESPACE\", job=\"$FULLNAME-worker-metrics\""

echo "== targets scraped through the ServiceMonitor and NetworkPolicy"
wait_for "server and worker targets up" 180 prom_at_least "sum(up{$SERVER}) + sum(up{$WORKER})" 3

echo "== phase 1: successful generation"
post_events 8
wait_for "completed generation attempts" 240 \
  prom_at_least "sum(claude_mem_generation_attempts_total{$WORKER, outcome=\"completed\"})" 5
wait_for "provider tokens" 60 prom_at_least "sum(claude_mem_provider_tokens_total{$WORKER, provider=\"openrouter\", model=\"mock-observer\"})" 42
wait_for "queue depth sampled" 60 prom_at_least "count(claude_mem_queue_jobs{$SERVER, state=\"waiting\"})" 1
wait_for "HTTP latency recorded" 60 prom_at_least "sum(claude_mem_http_request_duration_seconds_count{$SERVER, route=\"/v1/events\"})" 8

echo "== phase 2: provider outage fires ClaudeMemGenerationFailureRatio"
kubectl -n "$NAMESPACE" exec deploy/mock-provider -- curl -fsS -o /dev/null -X POST http://127.0.0.1:8080/mode/fail
provider_status=$(kubectl -n "$NAMESPACE" exec "deploy/$FULLNAME-worker" -- \
  curl -sS -o /dev/null -w '%{http_code}' -X POST http://mock-provider:8080/v1/chat/completions)
[[ "$provider_status" == 503 ]] || fail "mock provider answered $provider_status after switching to fail mode"
post_events 8
wait_for "ClaudeMemGenerationFailureRatio firing" 420 alert_firing ClaudeMemGenerationFailureRatio
expect_delivered ClaudeMemGenerationFailureRatio

echo "== phase 3: no worker fires ClaudeMemQueueBacklogGrowing"
kubectl -n "$NAMESPACE" scale "deploy/$FULLNAME-worker" --replicas=0
kubectl -n "$NAMESPACE" wait pod -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=worker" --for=delete --timeout=3m
post_events 10
wait_for "ClaudeMemQueueBacklogGrowing firing" 420 alert_firing ClaudeMemQueueBacklogGrowing
expect_delivered ClaudeMemQueueBacklogGrowing

echo "== phase 4: database outage fires ClaudeMemHttpErrorRatio"
kubectl -n "$NAMESPACE" annotate cluster pg --overwrite cnpg.io/hibernation=on
kubectl -n "$NAMESPACE" wait pod/pg-1 --for=delete --timeout=5m
http_errors() {
  local i
  for ((i = 0; i < 10; i++)); do
    curl -sS -o /dev/null -H "Authorization: Bearer $API_KEY" "$API/v1/usage" || true
  done
  alert_firing ClaudeMemHttpErrorRatio
}
wait_for "ClaudeMemHttpErrorRatio firing" 420 http_errors
expect_delivered ClaudeMemHttpErrorRatio

echo "== dashboard: every panel returns data through Grafana"
GRAFANA_AUTH="admin:$(kubectl -n "$MONITORING" get secret kps-grafana -o jsonpath='{.data.admin-password}' | base64 -d)"
wait_for "dashboard loaded by the Grafana sidecar" 180 \
  curl -fsS -o /dev/null -u "$GRAFANA_AUTH" "$GRAFANA/api/dashboards/uid/claude-mem"
DATASOURCE_UID=$(curl -fsS -u "$GRAFANA_AUTH" "$GRAFANA/api/datasources" | jq -r '[.[] | select(.type == "prometheus")][0].uid')
curl -fsS -u "$GRAFANA_AUTH" "$GRAFANA/api/dashboards/uid/claude-mem" \
  | jq -c '.dashboard.panels[] | select(.targets) | {title, targets: [.targets[].expr]}' > /tmp/panels.jsonl
[[ $(wc -l < /tmp/panels.jsonl) -ge 14 ]] || fail "dashboard has $(wc -l < /tmp/panels.jsonl) query panels"
while read -r panel; do
  title=$(jq -r .title <<<"$panel")
  while read -r expr; do
    expr=${expr//\$namespace/$NAMESPACE}
    expr=${expr//\$job/$FULLNAME}
    body=$(jq -n --arg uid "$DATASOURCE_UID" --arg expr "$expr" \
      '{from: "now-30m", to: "now", queries: [{refId: "A", datasource: {uid: $uid}, expr: $expr, range: true, intervalMs: 15000, maxDataPoints: 200}]}')
    points=$(curl -fsS -u "$GRAFANA_AUTH" -H 'Content-Type: application/json' -d "$body" "$GRAFANA/api/ds/query" \
      | jq '[.results.A.frames[]?.data.values[1]? // [] | .[] | select(. != null)] | length')
    [[ "$points" -gt 0 ]] || fail "panel \"$title\" returned no data for: $expr"
    echo "panel \"$title\": $points points"
  done < <(jq -r '.targets[]' <<<"$panel")
done < /tmp/panels.jsonl

echo "== phase 5: no server fires ClaudeMemServerDown"
kubectl -n "$NAMESPACE" scale "deploy/$FULLNAME-server" --replicas=0
wait_for "ClaudeMemServerDown firing" 300 alert_firing ClaudeMemServerDown
expect_delivered ClaudeMemServerDown

echo "== metric names and alert thresholds as deployed"
curl -fsS "$PROM/api/v1/label/__name__/values" | jq -r '.data[] | select(startswith("claude_mem_"))'
curl -fsS "$PROM/api/v1/rules" | jq -r '.data.groups[] | select(.name == "claude-mem") | .rules[] | "\(.name) [\(.state)] for=\(.duration)s\n\(.query)"'

kubectl -n "$NAMESPACE" annotate cluster pg --overwrite cnpg.io/hibernation=off
echo "OBSERVABILITY PASSED"
