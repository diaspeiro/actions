# Actions

A collection of reusable GitHub actions for updating, building, and releasing containers.

| name | description |
| --- | --- |
| [`duck`](duck/) | Dependency Update ChecK. Checks for new releases of dependencies from a configurable list of GitHub repos. If new versions are found, duck updates `.github/dependency-versions.json` (recording the version, download URL, and SHA-256 of each artifact) and opens/updates a PR. Runs as a scheduled job. |
| [`container-build-push`](container-build-push/) | Builds a container image and pushes it to a registry, with provenance + SBOM attestations. |

## Usage

duck writes `.github/dependency-versions.json`, a self-contained manifest that pins each dependency to a download URL and a content hash. The build (`Dockerfile`) reads that file directly — typically with `jq` — downloads each artifact, verifies its SHA-256, and builds from the verified tarball. No `git clone` of a mutable tag, and no Action is needed to feed versions into the build, so `docker build` works the same locally and in CI.

The release workflow below builds a container image and pushes it to GHCR:

```yaml
name: release
on:
  release:
    types: [published]

permissions:
  contents: read
  packages: write           # GHCR push with GITHUB_TOKEN
  id-token: write           # actions/attest
  attestations: write       # actions/attest
  artifact-metadata: write  # actions/attest

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./actions/container-build-push
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
          image-name: myorg/myimage   # GHCR is case-sensitive; use lowercase
```

For Docker Hub, the `packages: write` permission is not required, and the `registry` option does not need to be specified.

## Reference

### `container-build-push`

Caller must run `actions/checkout` before invoking this action.

Caller requires permissions:
- `id-token: write`
- `attestations: write`
- `artifact-metadata: write`
- `packages: write` (only when pushing to GHCR)

Attestation runs only when the repository is **public** (`github.event.repository.visibility == 'public'`). On private/internal repositories the attestation step is skipped: it emits a notice annotation and a "Attestation skipped" block on the run's Summary tab (both visible without expanding logs), the `id-token`/`attestations`/`artifact-metadata` permissions go unused, and the image is still built and pushed normally.

| input | required? | default value | description |
| --- | --- | --- | --- |
| `registry` | no | `docker.io` | Registry hostname. |
| `username` | yes | — | Registry username. This is typically `${{ github.actor }}` for GHCR. |
| `password` | yes | — | Registry password/token. |
| `image-name` | yes | — | Bare image path, e.g. `owner/repo`. |
| `context` | no | `.` | Build context. |
| `dockerfile` | no | `./Dockerfile` | Path to the Dockerfile. |
| `cache-scope` | no | `release-build` | GHA cache scope. Use distinct values for different images. |
| `build-args` | no | `''` | Multiline `KEY=value` build args passed through to `docker/build-push-action`. |
| `tags-format` | no | (see `action.yml`) | `docker/metadata-action` tag rules. |

| output | description |
| --- | --- |
| `digest` | Pushed image digest. |
| `metadata` | JSON metadata from `docker/metadata-action`. |

### `duck`

Caller requires permissions:
- `contents: write`
- `pull-requests: write`

duck is a Dependency Update ChecK, and runs as a scheduled action.

For each dependency configured in `.github/duck.json`, duck queries the upstream repo, resolves the artifact to download, and records its `version`, `url`, and `sha256` in `.github/dependency-versions.json`. If anything changed, duck commits the updated manifest to the `bot/dependency-updates` branch and opens (or updates) a PR.

The action takes no input or output parameters; everything is driven by the config file.

#### `.github/duck.json`

```json
{
  "dependencies": [
    {
      "name": "alpha",
      "repo": "acme/alpha",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "matchReleaseName": true,
      "assetPattern": "^alpha-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$"
    },
    {
      "name": "bravo",
      "repo": "globex/bravo",
      "pattern": "^v\\d+\\.\\d+\\.\\d+$",
      "stripPattern": "^v"
    },
    {
      "name": "frozen",
      "repo": "initech/frozen",
      "pattern": "^v\\d+\\.\\d+\\.\\d+$",
      "stripPattern": "^v",
      "lock": "1.4.2"
    },
    {
      "name": "wheel",
      "repo": "acme/wheel",
      "type": "commit",
      "commit": "d24655a708059d322633e361e2e204983e51f491"
    }
  ]
}
```

| field | required? | description |
| --- | --- | --- |
| `name` | yes | Lowercase key under which the dependency is recorded. Must be a valid POSIX shell identifier (letters, digits, underscores; cannot start with a digit). |
| `repo` | yes | Upstream GitHub repo as `owner/name`. This is the repo whose releases/tags are **scanned for versions** — it is decoupled from where the artifact comes from (see `assetPattern`). |
| `type` | no (default `release`) | `release`, `tag`, or `commit`. `release` scans GitHub releases; `tag` scans tags; `commit` pins a fixed SHA with no upstream search. |
| `pattern` | yes for `release`/`tag` | Regex matched against the release tag (or release name, if `matchReleaseName: true`), to identify and filter versions. Not used for `commit`. |
| `stripPattern` | no | Regex removed from the matched string before recording (e.g. `^v`). |
| `matchReleaseName` | no | Match `pattern`/`stripPattern` against the release's display name instead of its git tag. Use when the tag isn't a clean version string but the title is (e.g. curl, tagged `curl-8_11_0` but titled `8.11.0`). `release` only; ignored for `tag`/`commit`. |
| `assetPattern` | no | Regex matched against release **asset filenames** to select which artifact to download (e.g. a specific architecture). Exactly one asset must match — zero or multiple matches fail the run loudly. Only valid for `type: release`; rejected for `tag`/`commit` (they have no release assets). |
| `commit` | yes for `commit` | The commit SHA (7–40 hex chars) to pin to. The SHA is recorded as the dependency's `version`. |
| `lock` | no | Freeze the dependency at this exact version string. duck will not auto-update it, and emits a visible notice on every run. |

**Artifact selection.** When `assetPattern` is set, duck downloads the matching release asset. Otherwise it falls back to GitHub's auto-generated source archive at the resolved **commit** SHA (`https://github.com/<owner>/<repo>/archive/<sha>.tar.gz`), which GitHub guarantees is byte-stable. For `release`/`tag` deps without `assetPattern`, duck resolves the matched tag to its commit so the recorded URL is stable.

**Integrity vs. locking.** Every dependency is *integrity-pinned*: the manifest records the artifact's SHA-256 and the build verifies it. *Locking* (`lock`, or `type: commit`) is the separate, stronger choice of holding a dependency at a chosen version so duck never bumps it.

**Efficiency.** duck only downloads and re-hashes an artifact when a dependency's resolved version or URL changes; otherwise it carries the recorded hash forward, so a run with no updates makes no large downloads.

#### `.github/dependency-versions.json`

A flat JSON map of dependency name to `{ version, url, sha256, locked? }`, written by duck. **Do not edit by hand** — locking is configured in `duck.json`, not here.

```json
{
  "alpha": {
    "version": "8.11.0",
    "url": "https://github.com/acme/alpha/releases/download/v8.11.0/alpha-8.11.0.tar.gz",
    "sha256": "…"
  },
  "frozen": {
    "version": "1.4.2",
    "url": "https://github.com/initech/frozen/archive/<sha>.tar.gz",
    "sha256": "…",
    "locked": true
  }
}
```

#### Usage

```yaml
name: duck
on:
  schedule:
    - cron: '17 6 * * 1'   # Mondays at 06:17 UTC
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: ./actions/duck
```

The action always updates the `bot/dependency-updates` branch; if the branch already has an open PR, duck updates it in place. If the branch has drifted to match `main`, duck closes the PR and deletes the branch.
