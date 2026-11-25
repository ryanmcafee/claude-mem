{{- define "claude-mem.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "claude-mem.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "claude-mem.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "claude-mem.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "claude-mem.selectorLabels" -}}
app.kubernetes.io/name: {{ include "claude-mem.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "claude-mem.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "claude-mem.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "claude-mem.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "claude-mem.valkeyFullname" -}}
{{- printf "%s-valkey" (include "claude-mem.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fails the render on any configuration the chart must never deploy. */}}
{{- define "claude-mem.validate" -}}
{{- if ne .Values.auth.mode "api-key" -}}
{{- fail (printf "auth.mode=%s is not allowed: the chart only deploys CLAUDE_MEM_AUTH_MODE=api-key (local-dev disables authentication)" .Values.auth.mode) -}}
{{- end -}}
{{- if not .Values.database.existingSecret -}}
{{- fail "database.existingSecret is required (for CloudNativePG use the <cluster>-app Secret)" -}}
{{- end -}}
{{- $redisSources := 0 -}}
{{- if .Values.redis.url }}{{ $redisSources = add1 $redisSources }}{{ end -}}
{{- if .Values.redis.existingSecret }}{{ $redisSources = add1 $redisSources }}{{ end -}}
{{- if .Values.valkey.enabled }}{{ $redisSources = add1 $redisSources }}{{ end -}}
{{- if ne (int $redisSources) 1 -}}
{{- fail "set exactly one of redis.url, redis.existingSecret or valkey.enabled (dev only)" -}}
{{- end -}}
{{- if contains "@" .Values.redis.url -}}
{{- fail "redis.url must not embed credentials; put the full URL in redis.existingSecret instead" -}}
{{- end -}}
{{- $provider := .Values.generation.provider -}}
{{- if and (eq $provider "anthropic") (not .Values.generation.anthropicApiKey.enabled) -}}
{{- fail "generation.provider=anthropic requires generation.anthropicApiKey.enabled=true (metered billing)" -}}
{{- end -}}
{{- if and (eq $provider "openai") (not .Values.generation.openaiApiKey.enabled) -}}
{{- fail "generation.provider=openai requires generation.openaiApiKey.enabled=true (metered billing)" -}}
{{- end -}}
{{- if and (or .Values.generation.anthropicApiKey.enabled .Values.generation.openaiApiKey.enabled) (not .Values.generation.existingSecret) -}}
{{- fail "generation.existingSecret is required when a provider API key is enabled" -}}
{{- end -}}
{{- if and .Values.worker.autoscaling.enabled .Values.worker.keda.enabled -}}
{{- fail "worker.autoscaling and worker.keda are mutually exclusive" -}}
{{- end -}}
{{- if and .Values.worker.keda.enabled (not .Values.worker.keda.address) (not .Values.valkey.enabled) -}}
{{- fail "worker.keda.address (host:port of Redis/Valkey) is required when worker.keda.enabled=true" -}}
{{- end -}}
{{- if and .Values.ingress.enabled .Values.httpRoute.enabled -}}
{{- fail "enable at most one of ingress and httpRoute" -}}
{{- end -}}
{{- range (concat .Values.extraEnv .Values.server.extraEnv .Values.worker.extraEnv) }}
{{- if eq .name "CLAUDE_MEM_INCLUDE_SHARED" -}}
{{- fail "CLAUDE_MEM_INCLUDE_SHARED is not configurable through this chart while shared scope is gated" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Annotation values must be strings; quote numbers and booleans passed via --set. */}}
{{- define "claude-mem.stringMap" -}}
{{- range $key, $value := . }}
{{ $key }}: {{ $value | toString | quote }}
{{- end }}
{{- end -}}

{{- define "claude-mem.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
{{- end -}}

{{/* Postgres, Redis and auth env shared by every pod that touches the database. */}}
{{- define "claude-mem.coreEnv" -}}
- name: CLAUDE_MEM_RUNTIME
  value: server-beta
- name: CLAUDE_MEM_AUTH_MODE
  value: api-key
- name: CLAUDE_MEM_DATA_DIR
  value: /data/claude-mem
{{- if eq .Values.database.mode "uri" }}
{{ include "claude-mem.secretEnv" (dict "name" "CLAUDE_MEM_SERVER_DATABASE_URL" "secret" .Values.database.existingSecret "key" .Values.database.uriKey) }}
{{- else }}
{{ include "claude-mem.secretEnv" (dict "name" "CLAUDE_MEM_PGHOST" "secret" .Values.database.existingSecret "key" .Values.database.hostKey) }}
{{ include "claude-mem.secretEnv" (dict "name" "CLAUDE_MEM_PGPORT" "secret" .Values.database.existingSecret "key" .Values.database.portKey) }}
{{ include "claude-mem.secretEnv" (dict "name" "CLAUDE_MEM_PGDATABASE" "secret" .Values.database.existingSecret "key" .Values.database.dbnameKey) }}
{{ include "claude-mem.secretEnv" (dict "name" "PGUSER" "secret" .Values.database.existingSecret "key" .Values.database.usernameKey) }}
{{ include "claude-mem.secretEnv" (dict "name" "PGPASSWORD" "secret" .Values.database.existingSecret "key" .Values.database.passwordKey) }}
- name: CLAUDE_MEM_SERVER_DATABASE_URL
  value: postgresql://$(CLAUDE_MEM_PGHOST):$(CLAUDE_MEM_PGPORT)/$(CLAUDE_MEM_PGDATABASE)
{{- end }}
{{- with .Values.database.sslMode }}
- name: CLAUDE_MEM_POSTGRES_SSL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.database.poolMax }}
- name: CLAUDE_MEM_POSTGRES_POOL_MAX
  value: {{ . | quote }}
{{- end }}
- name: CLAUDE_MEM_QUEUE_ENGINE
  value: bullmq
- name: CLAUDE_MEM_REDIS_MODE
  value: external
- name: CLAUDE_MEM_QUEUE_REDIS_PREFIX
  value: {{ .Values.redis.queuePrefix | quote }}
{{- if .Values.redis.existingSecret }}
{{ include "claude-mem.secretEnv" (dict "name" "CLAUDE_MEM_REDIS_URL" "secret" .Values.redis.existingSecret "key" .Values.redis.urlKey) }}
{{- else if .Values.valkey.enabled }}
- name: CLAUDE_MEM_REDIS_URL
  value: {{ printf "redis://%s:6379" (include "claude-mem.valkeyFullname" .) | quote }}
{{- else }}
- name: CLAUDE_MEM_REDIS_URL
  value: {{ .Values.redis.url | quote }}
{{- end }}
- name: CLAUDE_MEM_CHROMA_ENABLED
  value: "false"
- name: CLAUDE_MEM_SERVER_SCHEMA_BOOTSTRAP
  value: "false"
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Provider credentials: only the worker receives these, and metered keys only when enabled. */}}
{{- define "claude-mem.generationEnv" -}}
{{- $g := .Values.generation -}}
{{- if and $g.claudeCodeOAuthToken.enabled $g.existingSecret }}
{{ include "claude-mem.secretEnv" (dict "name" "CLAUDE_CODE_OAUTH_TOKEN" "secret" $g.existingSecret "key" $g.claudeCodeOAuthToken.key) }}
{{- end }}
{{- if $g.anthropicApiKey.enabled }}
{{ include "claude-mem.secretEnv" (dict "name" "ANTHROPIC_API_KEY" "secret" $g.existingSecret "key" $g.anthropicApiKey.key) }}
{{- end }}
{{- if $g.openaiApiKey.enabled }}
{{ include "claude-mem.secretEnv" (dict "name" "OPENAI_API_KEY" "secret" $g.existingSecret "key" $g.openaiApiKey.key) }}
{{ include "claude-mem.secretEnv" (dict "name" "CLAUDE_MEM_OPENROUTER_API_KEY" "secret" $g.existingSecret "key" $g.openaiApiKey.key) }}
{{- end }}
{{- with $g.openaiBaseUrl }}
- name: OPENAI_BASE_URL
  value: {{ . | quote }}
- name: CLAUDE_MEM_OPENROUTER_BASE_URL
  value: {{ . | quote }}
{{- end }}
{{- if and (eq $g.provider "claude-code") $g.claudeCodeOAuthToken.enabled $g.existingSecret }}
- name: CLAUDE_MEM_SERVER_PROVIDER
  value: claude-code
{{- else if eq $g.provider "anthropic" }}
- name: CLAUDE_MEM_SERVER_PROVIDER
  value: claude
{{- else if eq $g.provider "openai" }}
- name: CLAUDE_MEM_SERVER_PROVIDER
  value: openrouter
{{- end }}
{{- with $g.model }}
- name: CLAUDE_MEM_SERVER_MODEL
  value: {{ . | quote }}
{{- end }}
{{- with $g.maxOutputTokens }}
- name: CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{- define "claude-mem.writableVolumeMounts" -}}
- name: data
  mountPath: /data/claude-mem
- name: claude-config
  mountPath: /home/node/.claude
- name: claude-mem-home
  mountPath: /home/node/.claude-mem
- name: tmp
  mountPath: /tmp
{{- end -}}

{{- define "claude-mem.writableVolumes" -}}
- name: data
  emptyDir: {}
- name: claude-config
  emptyDir: {}
- name: claude-mem-home
  emptyDir: {}
- name: tmp
  emptyDir: {}
{{- end -}}

{{- define "claude-mem.topologySpread" -}}
{{- if .spec.topologySpreadConstraints }}
{{ toYaml .spec.topologySpreadConstraints }}
{{- else }}
- maxSkew: 1
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "claude-mem.selectorLabels" (dict "root" .root "component" .component) | nindent 6 }}
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "claude-mem.selectorLabels" (dict "root" .root "component" .component) | nindent 6 }}
{{- end }}
{{- end -}}
