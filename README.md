# Hivemnd CLI

Public Node/TypeScript client for downloading company-approved skills and
installing them safely in Codex and Claude.

## Install and configure

```sh
npm install --global @hivemnd-ai/cli

hivemnd --version

hivemnd config init --api-url https://shared.hivemnd.cloud/eigen
hivemnd config destination add codex-global \
  --agent codex \
  --scope root
hivemnd config destination add codex-this-workspace \
  --agent codex \
  --scope workspace \
  --path "$PWD"
hivemnd config destination add claude-this-workspace \
  --agent claude \
  --scope workspace \
  --path "$PWD"

hivemnd login --enrollment-url 'https://shared.hivemnd.cloud/eigen/login?token=ONE_TIME_TOKEN'
hivemnd doctor
hivemnd sync
hivemnd sync --apply
```

Stable GitHub releases publish the matching package version to npm through
`.github/workflows/release.yml`. The release tag must be exactly `v` followed by
the version in `package.json`, and the built `hivemnd --version` output must
match both before publication. The public package is published with npm
provenance and then installed from the registry in a clean directory as the
final release check.

The default config is `~/.hivemnd/config.json`. Override the state directory
with `HIVEMND_HOME`, or only the config path with `HIVEMND_CONFIG` or
`--config`. `config init` refuses to replace an existing config unless `--force`
is explicit.

`apiUrl` is the complete deployment base, including any tenant path. Shared
EIGEN therefore uses `https://shared.hivemnd.cloud/eigen`; a future dedicated
deployment may use `https://eigen.hivemnd.cloud`, and on-premise installations
may supply their own base URL. API endpoints and content URLs are resolved
inside that base. Same-origin URLs outside its tenant path are rejected.

## Named destinations

Each destination has an independent name, agent, scope and ownership ledger.
Several destinations can use the same agent, so one invocation can keep skills
available globally and in several workspaces.

| Scope       | `--path`            | Codex installation root | Claude installation root |
| ----------- | ------------------- | ----------------------- | ------------------------ |
| `root`      | omitted             | `~/.agents`             | `~/.claude`              |
| `workspace` | workspace directory | `<workspace>/.agents`   | `<workspace>/.claude`    |
| `directory` | exact agent root    | exact supplied path     | exact supplied path      |

Artifacts keep backend-provided relative paths such as
`skills/<slug>/SKILL.md`. Consequently, Codex workspace skills land in
`<workspace>/.agents/skills` and Claude workspace skills in
`<workspace>/.claude/skills`, matching each agent's discovery contract.

Manage destinations without editing JSON directly:

```sh
hivemnd config destination add api-codex \
  --agent codex --scope workspace --path /absolute/path/to/api
hivemnd config destination remove api-codex
hivemnd config show
```

Synchronize every configured destination, one destination, or a selected set:

```sh
hivemnd sync --apply
hivemnd sync --destination api-codex --apply
hivemnd sync --destination api-codex --destination web-claude --apply
```

Running the command again fetches the latest authorized release, compares it
with the local ownership ledgers, and applies only required changes. There is no
background daemon or persistent connection. To run the same synchronization
periodically for the current config, install the native user-level scheduler:

```sh
hivemnd schedule install
hivemnd schedule install --interval 30
hivemnd schedule status
hivemnd schedule remove
```

The default interval is 15 minutes. macOS uses a LaunchAgent and Linux uses a
systemd user timer; Windows intentionally reports the Task Scheduler command
that an administrator must configure. Every schedule is isolated by the exact
tenant URL and absolute config path, can be installed again safely, and invokes
the absolute Node runtime with the absolute installed CLI script as
`<node> <cli-script> --config <absolute-path> sync --apply`. This avoids relying
on a shell, inherited `PATH`, or the npm bin shim's `/usr/bin/env node` shebang.
It stores no token. Logs and minimal scheduler metadata live under
`$HIVEMND_HOME/logs` and `$HIVEMND_HOME/schedules` (normally `~/.hivemnd`) with
private permissions. Authentication still comes from Keychain or the scheduled
process environment at execution time.

To adopt skills already present in a destination, preview and then apply the
explicit adoption mode:

```sh
hivemnd sync --destination codex-this-workspace --adopt-existing
hivemnd sync --destination codex-this-workspace --adopt-existing --apply
```

Adoption only records ownership when the existing bytes have exactly the
authorized SHA-256. Different content remains an `unmanaged-existing-file`
conflict and is never changed.

## Authentication

`hivemnd login` accepts either a one-time enrollment URL or a bearer token. It
validates access against the manifest before persisting anything. On macOS it
stores the credential in Keychain under the `hivemnd-cli` service. Headless
systems can provide `HIVEMND_TOKEN` for the current process; the CLI has no
plaintext credential-file fallback.

Prefer `HIVEMND_TOKEN` over `--token` in automation so a long-lived token is not
copied into shell history. The CLI identifies enrollment requests as
`hivemnd_cli`; the backend must accept that value.

## PostgreSQL sources

`hivemnd sources list` calls `GET /api/v1/sources` and displays only the sources
and effective actions authorized by the backend. `hivemnd sources inspect
SOURCE_UUID` calls `GET /api/v1/sources/:id/schema` and prints the ordered
PostgreSQL schemas, tables and columns returned by the server.

The CLI validates both responses strictly. It does not connect to customer
databases or apply client-side authorization. Query execution remains an MCP and
backend responsibility, not a CLI feature.

## Synchronization safety

- Dry-run is the default; local writes require `--apply`.
- Manifests are schema- and expiry-checked. A manifest's required
  `minimum_client_version` is validated as SemVer and enforced before any
  artifact download, plan or write. Downloads are size- and SHA-256-checked
  before planning begins.
- Remote content paths must remain on the configured Hivemnd origin.
- Destination paths must remain inside their configured root and cannot traverse
  symlinks or the reserved `.hivemnd` namespace.
- Existing unmanaged files and locally modified managed files become conflicts;
  they are never overwritten or claimed silently.
- Writes use private temporary files and atomic rename. A failed multi-
  destination apply restores files and every affected ownership ledger.
- Ownership state is isolated under
  `~/.hivemnd/destinations/<origin-id>/<destination>/ownership.json`. It stores
  IDs and hashes, never credentials or artifact content.
- Applied receipts contain artifact-version IDs, agent targets and outcomes
  only. Receipt delivery is best-effort after local success.

Manifest signature verification remains unimplemented until the backend
signing-key distribution and canonicalization contract is approved. TLS,
authorization, same-origin downloads and local hash verification are the active
controls.

## CLI updates

At most once per day, ordinary successful commands query the public npm
metadata endpoint for the latest stable `@hivemnd-ai/cli` version. The check is
advisory, times out quickly, and never makes the requested command fail. Its
private cache is `$HIVEMND_HOME/update-check.json`. When an update exists, the
CLI prints the notice after the command's normal output.

Check explicitly at any time:

```sh
hivemnd update check
```

The CLI never changes its own installation. To accept an available update, run:

```sh
npm install --global @hivemnd-ai/cli@latest
```

## Development

```sh
npm install
npm run check
npm audit
```

The integration-oriented suite enforces 100% statements, branches, functions
and lines for application TypeScript. `src/cli.ts` is the composition root;
command registration, workflows, runtime ports and filesystem/API adapters stay
separate.

## Release

The npm publisher should be configured for `hivemnd-ai/cli` using the exact
workflow filename `release.yml`, with `npm publish` allowed and no GitHub
environment. The workflow uses GitHub OIDC and grants only `contents: read` and
`id-token: write`; npm automatically exchanges that identity for a short-lived
credential. After trusted publishing is active, configure npm to require 2FA
and disallow traditional publish tokens.

Because npm requires a package to exist before its trusted publisher can be
configured, the first release may use a one-time granular npm token stored only
as the encrypted GitHub Actions secret `NPM_TOKEN`. Delete that secret
immediately after the first successful publish, configure the trusted publisher,
and use OIDC for every later release. Never commit a token or write one into a
workflow file.

To release, update `package.json`, `package-lock.json`, and
`defaultDependencies.clientVersion` to the same new version, merge to `main`,
then publish a non-prerelease GitHub release tagged `v<version>`. npm versions
and release tags are immutable; never reuse either.
