# Container image

Run the same build, read-only runtime smoke test and HIGH/CRITICAL vulnerability
policy used by CI from the repository root:

```sh
bash scripts/container/check.sh
```

Requires Docker with Buildx, Bash, Python 3.12+, OpenSSL and Trivy **0.74.0**. The smoke test
starts disposable Postgres and Valkey containers and performs no provider calls.
No credentials or secrets are needed. Production provider configuration is not
part of this test; generation against a real provider needs separate QA.

## Publication

`.github/workflows/container-publish.yml` builds natively on amd64 and arm64 on
GitHub-hosted runners. Every PR builds, scans and tests both architectures. Main
pushes publish `ghcr.io/<owner>/<repo>:sha-<first-seven-commit-characters>`.
`vX.Y.Z` tag pushes (the same source as `npm-publish.yml`) and published releases
publish `X.Y.Z`, `X.Y`, and `X`; prereleases publish only their complete version.
The release tag must match `package.json`. No `latest` tag is created.

**Fail fast, fail loud:** HIGH and CRITICAL findings block, including unfixed
findings. Missing images, scan errors and missing artifacts fail. An old Alpine
fixture proves the scanner returns a finding and a failing exit code. Do not
bypass the gate: update the affected base image or dependency and rerun it.

**Least-privilege CI:** build/test jobs have only contents read. The publication
job gets packages write and OIDC, never checks out source or runs repository
scripts, and copies the exact scanned OCI archives with their BuildKit SBOM and
maximal provenance attestations. Cosign signs the assembled index by digest;
verification precedes promotion to consumer tags. `build-<run>-<attempt>*` tags
are staging artifacts, not consumer tags. Failed publication can leave these
unsigned staging tags behind; do not deploy them.

**Reproducibility:** base images and actions are pinned by digest/commit; plugin
runtime dependencies use the committed Bun lockfile; Claude CLI, Bun, Trivy and
Cosign versions are explicit. Debian runtime packages are security-updated at
build time, so rebuilds can differ. Artifact handoff avoids rebuilding between
scan and release. Update base digests and tool versions in a reviewed PR, with
both architecture checks passing.

Fork PRs need no package credentials and never publish. A fork's main publishes
to its own lowercase repository namespace using its own `GITHUB_TOKEN`. GitHub
Actions/package publishing and public arm64 runners must be enabled in that
repository. GHCR packages may initially be private; the repository/package owner
must set package visibility to public before unauthenticated cluster pulls.

Verify a published main image (replace the SHA tag or, preferably, use its digest):

```sh
cosign verify \
  --certificate-identity 'https://github.com/ryanmcafee/claude-mem/.github/workflows/container-publish.yml@refs/heads/main' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/ryanmcafee/claude-mem:sha-REPLACE
```

For a release, use the workflow's `@refs/tags/vX.Y.Z` identity. Inspect SBOM and
provenance using `docker buildx imagetools inspect IMAGE --format '{{json .SBOM}}'`
and `--format '{{json .Provenance}}'`. These are BuildKit attestations bound into
the signed index, rather than separate Cosign attestations.

## Writable paths for the Helm chart

Run as UID/GID **1000**, set `fsGroup: 1000`, `readOnlyRootFilesystem: true`, drop
all capabilities and disable privilege escalation. Mount these as writable
`emptyDir` volumes (one volume per path):

| Mount | Why it is writable |
| --- | --- |
| `/data/claude-mem` | `CLAUDE_MEM_DATA_DIR`: runtime PID/port state, logs, settings and local scratch/cache. Postgres is canonical storage. |
| `/home/node/.claude` | Claude CLI state and the optional copied credentials file. Mount source credentials separately, read-only, at `/run/secrets/...`. |
| `/home/node/.claude-mem` | Home-relative compatibility settings/state used by bundled helpers and created by the entrypoint. |
| `/tmp` | Runtime temporary files, Bun/Claude subprocess scratch, XDG cache (`/tmp/.cache`). |

The image root, `/home/node` itself, `/opt/claude-mem` and `/opt/claude-cli` stay
read-only. No npm, compiler, make, uv or build-stage dependencies are installed
in the final image. Node/Bun, Git, curl and Claude are runtime tools. The image
serves the server-beta runtime; legacy Chroma/uv tooling is outside this image's
contract. A custom `CLAUDE_MEM_DATA_DIR` or `CLAUDE_CONFIG_DIR` requires a matching
writable mount. Provider credentials should remain read-only Secrets; the
entrypoint copies a supplied `CLAUDE_MEM_CREDENTIALS_FILE` into `.claude` with
mode 0600.

## Runtime budget

Before this change there was no container gate (0 CI minutes). The two native
architecture jobs run concurrently with a 40-minute timeout each; publication
has a 20-minute timeout. The health smoke has 60 seconds for Postgres and 90
seconds for HTTP readiness. The first run built both architectures and reached the scan gate in 99–106
seconds per job (it exposed an OCI archive adapter error, since corrected).
Full successful build/scan/smoke timings are still pending; timeouts are bounds,
not measurements. There is no shared
build cache: per-job BuildKit cache only accelerates the smoke image export,
preventing cross-branch cache poisoning and stale dependency validation.
