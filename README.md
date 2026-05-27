# Actions

A collection of reusable GitHub actions for updating, building, and releasing containers.

| name | description |
| --- | --- |
| [`duck`](duck/) | Dependency Update ChecK. Checks for new releases of dependencies from a configurable list of GitHub repos. If new versions are found, duck will update `.github/dependency-versions` and open/update a PR. Runs as a scheduled job. |
| [`load-dependency-versions`](load-dependency-versions/) | Reads a KEY=value file (default `.github/dependency-versions`) and exposes the contents as Docker `build-args`. |
| [`container-build-push`](container-build-push/) | Builds a container image and pushes it to a registry, with provenance + SBOM attestations. |

## Usage

The release workflow below loads the current dependency versions sourced from `duck`, builds a container image, and pushes it to GHCR:

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
      - id: deps
        uses: ./actions/load-dependency-versions
      - uses: ./actions/container-build-push
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
          image-name: myorg/myimage   # GHCR is case-sensitive; use lowercase
          build-args: ${{ steps.deps.outputs.build-args }}
```

For Docker, the `packages: write` permission is not required, and the registry option does not need to be specified:

```yaml
- uses: ./actions/container-build-push
  with:
    username: ${{ secrets.DOCKERHUB_USER }}
    password: ${{ secrets.DOCKERHUB_TOKEN }}
    image-name: myorg/myimage
    build-args: ${{ steps.deps.outputs.build-args }}
```

If you do not have duck-managed dependencies, you can remove the `load-dependency-versions` stage and omit the `build-args` option for `container-build-push`.

## Reference

### `load-dependency-versions`

| input | required? | default value | description |
| --- | --- | --- | --- |
| `file` | no | `.github/dependency-versions` | Path to the KEY=value dependency version file. |

| output | description |
| --- | --- |
| `build-args` | Multiline `KEY=value` string suitable for `docker/build-push-action`. Empty if the file is absent or has no entries. |

### `container-build-push`

Caller must run `actions/checkout` before invoking this action.

Caller requires permissions:
- `id-token: write`
- `attestations: write`
- `artifact-metadata: write`
- `packages: write` (only when pushing to GHCR)

| input | required? | default value | description |
| --- | --- | --- | --- |
| `registry` | no | `docker.io` | Registry hostname. |
| `username` | yes | — | Registry username. This is typically `${{ github.actor }}` for GHCR. |
| `password` | yes | — | Registry password/token. |
| `image-name` | yes | — | Bare image path, e.g. `owner/repo`. |
| `context` | no | `.` | Build context. |
| `dockerfile` | no | `./Dockerfile` | Path to the Dockerfile. |
| `cache-scope` | no | `release-build` | GHA cache scope. Use distinct values for different images. |
| `build-args` | no | `''` | Multiline `KEY=value` build args. |
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

For each depdendency configured in `.github/duck.json`, duck will query the upstream repo for its latest matching release. If any new releases are found, duck will update `.github/dependency-versions` on the `bot/dependency-updates` branch and open a PR.

The action does not take input or output parameters, everything is managed by the config file.

#### Example .github/duck.json

```json
{
  "dependencies": [
    {
      "name": "alpha",
      "repo": "acme/alpha",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "useName": true
    },
    {
      "name": "bravo",
      "repo": "globex/bravo",
      "pattern": "^v\\d+\\.\\d+\\.\\d+$",
      "stripPattern": "^v"
    }
  ]
}
```

- `name` — must be valid as a POSIX shell identifier (letters, digits, underscores; cannot start with a digit).
- `repo` — upstream GitHub repo as `owner/name`.
- `pattern` — regex matched against the GitHub release tag (or release name, if `useName: true`).
- `stripPattern` (optional) — regex removed from the matched string before recording.
- `useName` (optional) — match against the release's display name instead of its tag.

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

The action will always update the `bot/dependency-updates` branch; if the branch already has an open PR, duck updates it in place. If the branch has drifted to match `main`, duck closes the PR and deletes the branch.
