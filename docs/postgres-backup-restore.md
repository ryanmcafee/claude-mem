# Postgres Backup And Restore

Applies to the centrally deployed server runtime (`ryanmcafee/claude-mem` issue #1,
scope section 4). Postgres is the only canonical store; everything else in the
deployment is derived or transient:

| Store | Canonical? | On loss |
| --- | --- | --- |
| Postgres | yes | restore from a backup — this document |
| Valkey / Redis (BullMQ) | no | in-flight generation jobs are re-enqueued from `observation_generation_jobs` |
| Chroma | no | rebuilt from `observations` by re-running the sync/reindex path |

Two paths are supported. The CloudNativePG Barman Cloud plugin is the primary
path because it gives continuous WAL archiving and therefore point-in-time
recovery. The `pg_dump` CronJob is the portable fallback for any other Postgres
(a managed service, a plain container, a laptop).

Both paths end with a verification step. A backup nobody has restored is not a
backup, so `scripts/pg-backup-restore-drill.ts` walks the portable path end to
end against throwaway databases and CI runs it on every PR.

## Primary path: CloudNativePG Barman Cloud plugin

Requires CloudNativePG 1.26 or newer with the Barman Cloud plugin installed in
the operator's namespace (the plugin needs cert-manager). In CNPG 1.26 the
in-core `barmanObjectStore` configuration moved into this plugin; see
https://cloudnative-pg.io/plugin-barman-cloud/ for install manifests.

Substitute your own bucket, endpoint, secret names and cluster name. Nothing
here may be hard-coded to one operator's cloud.

### 1. Object store and credentials

```yaml
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: claude-mem-backups
spec:
  # Keep backups for at least as long as your recovery requirement.
  retentionPolicy: "30d"
  configuration:
    destinationPath: s3://BUCKET/claude-mem
    # endpointURL is only needed for non-AWS S3 (MinIO, R2, Ceph...).
    endpointURL: https://S3_ENDPOINT
    s3Credentials:
      accessKeyId:
        name: claude-mem-backup-credentials
        key: ACCESS_KEY_ID
      secretAccessKey:
        name: claude-mem-backup-credentials
        key: ACCESS_SECRET_KEY
    wal:
      compression: gzip
    data:
      compression: gzip
```

The credentials Secret is an ordinary Kubernetes Secret. In a GitOps repository
it must come from External Secrets or the 1Password operator; never commit the
keys.

### 2. Point the cluster at it

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: claude-mem-pg
spec:
  instances: 3
  storage:
    size: 20Gi
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        barmanObjectName: claude-mem-backups
```

`isWALArchiver: true` is what turns on continuous archiving. Without it you get
periodic base backups and no point-in-time recovery.

### 3. Schedule base backups

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: claude-mem-pg-nightly
spec:
  # Six fields: seconds first. This is 01:30 every day.
  schedule: "0 30 1 * * *"
  immediate: true
  backupOwnerReference: self
  cluster:
    name: claude-mem-pg
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
```

Check that it is working before you need it:

```sh
kubectl get backups.postgresql.cnpg.io -n NAMESPACE
kubectl cnpg status claude-mem-pg -n NAMESPACE   # "Continuous Backup" section
```

A cluster with WAL archiving configured but failing reports the archiving error
in `kubectl cnpg status`. Treat a non-empty archiving error as an outage of the
backup, not a warning.

### 4. Restore

Recovery is never in place. CNPG bootstraps a **new** cluster from the object
store, so the restore is non-destructive: the original cluster keeps running
while you verify the copy.

Full restore (latest available data):

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: claude-mem-pg-restored
spec:
  instances: 1
  storage:
    size: 20Gi
  bootstrap:
    recovery:
      source: origin
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: claude-mem-backups
          # The ORIGINAL cluster's name, which is how its backups are keyed.
          serverName: claude-mem-pg
```

Point-in-time restore — add a `recoveryTarget`. Use this for "someone purged a
project at 14:05":

```yaml
  bootstrap:
    recovery:
      source: origin
      recoveryTarget:
        targetTime: "2026-09-28 14:04:00+00"
```

Then, in order:

1. Wait for the restored cluster to be ready:
   `kubectl cnpg status claude-mem-pg-restored -n NAMESPACE`
2. Verify the data before cutting over. Row counts and the newest observation
   are enough to tell a good restore from an empty one:
   ```sh
   kubectl exec -n NAMESPACE claude-mem-pg-restored-1 -- psql -U postgres -d app -c \
     "SELECT (SELECT count(*) FROM teams) AS teams,
             (SELECT count(*) FROM projects) AS projects,
             (SELECT count(*) FROM observations) AS observations,
             (SELECT max(created_at) FROM observations) AS newest"
   ```
3. Repoint the application. The chart reads Postgres credentials from
   `database.existingSecret`; set it to the restored cluster's `-app` Secret
   (`claude-mem-pg-restored-app`) and redeploy the server and worker.
4. Rebuild Chroma so search reflects the restored rows.
5. Keep the failed cluster until the restore has been in production for a full
   backup cycle.

If the restored cluster must keep archiving (it should, once it is the live
one), give it its own `plugins` block pointing at a **different**
`barmanObjectName`. Two clusters writing backups under the same object store
name will fight over the same WAL namespace.

## Fallback path: pg_dump CronJob

Portable, no operator required, and the only option against a managed Postgres
you do not control. The trade-off is explicit: the recovery point is the last
dump, so an hourly schedule means up to an hour of lost observations.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: claude-mem-pg-dump
spec:
  schedule: "0 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          securityContext:
            runAsNonRoot: true
            runAsUser: 26          # postgres in the upstream image
            fsGroup: 26
          containers:
            - name: pg-dump
              image: postgres:16
              securityContext:
                allowPrivilegeEscalation: false
                readOnlyRootFilesystem: true
                capabilities:
                  drop: ["ALL"]
              env:
                - name: PGCONNECT_TIMEOUT
                  value: "10"
                # A CloudNativePG `-app` Secret already provides `uri`.
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: claude-mem-pg-app
                      key: uri
              command: ["/bin/sh", "-c"]
              args:
                - |
                  set -euo pipefail
                  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
                  out="/backups/claude-mem-${stamp}.dump"
                  pg_dump --dbname "$DATABASE_URL" \
                    --format=custom --no-owner --no-privileges \
                    --file "$out"
                  # Fail loudly on a truncated dump instead of storing it.
                  pg_restore --list "$out" > /dev/null
                  ls -1t /backups/claude-mem-*.dump | tail -n +25 | xargs -r rm --
              volumeMounts:
                - name: backups
                  mountPath: /backups
                - name: tmp
                  mountPath: /tmp
          volumes:
            - name: backups
              persistentVolumeClaim:
                claimName: claude-mem-backups
            - name: tmp
              emptyDir: {}
```

A PVC keeps this example self-contained. For off-cluster copies, pipe to object
storage in the same step (`pg_dump ... --file=- | aws s3 cp - s3://BUCKET/...`)
and keep the `pg_restore --list` check on the local copy before upload. A dump
that only exists in the same failure domain as the database is not a backup.

### Restore from a dump

Restore into a throwaway database first, verify it, and only then swap. Never
`pg_restore --clean` straight over the live database.

```sh
# 1. A scratch database next to the live one.
createdb -h HOST -U postgres claude_mem_restore_check

# 2. Restore the dump into it.
pg_restore --dbname "postgres://USER:PASSWORD@HOST:5432/claude_mem_restore_check" \
  --no-owner --no-privileges /backups/claude-mem-20260928T010000Z.dump

# 3. Verify before believing it.
psql -h HOST -U postgres -d claude_mem_restore_check -c \
  "SELECT (SELECT count(*) FROM teams) AS teams,
          (SELECT count(*) FROM projects) AS projects,
          (SELECT count(*) FROM observations) AS observations"

# 4. Cut over: point `database.existingSecret` at the verified database (or
#    rename it into place during a maintenance window), redeploy, rebuild Chroma.
```

`pg_restore` must be at least the major version of the server that produced the
dump. Running it from the same `postgres:16` image that took the dump avoids the
mismatch entirely.

## The restore drill

```sh
CLAUDE_MEM_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  bun scripts/pg-backup-restore-drill.ts
```

What it does, in the same order an operator would:

1. Creates two throwaway databases (`claude_mem_drill_source`,
   `claude_mem_drill_restored`).
2. Bootstraps the real server schema in the source and seeds teams, a project
   and observations through the product's own repositories.
3. Records row counts and an md5 digest of the observation bodies.
4. `pg_dump --format=custom` -> `pg_restore` into the second database.
5. Re-reads counts and the digest from the restored copy and fails the run on
   any difference.
6. Drops both databases (`--keep` leaves them for inspection).

CI runs this in the `import-and-backup (postgres)` job, so a change that breaks
the restore path fails the build instead of surfacing during an incident.

## Related

- Importing a local SQLite database into the central store:
  [migration-worker-to-server.md](migration-worker-to-server.md)
- Deployment and configuration: [server.md](server.md)
