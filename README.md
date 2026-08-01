# Hivemnd CLI

Public Node/TypeScript client for downloading company-approved skills and
installing them safely in Codex and Claude Code.

## Install and configure

```sh
npm install --global @hivemnd-ai/cli

hivemnd --version

hivemnd init
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

Multi-organization routing lives in `~/.hivemnd/registry.json`; each organization
keeps an isolated single-tenant config and Keychain credential. An existing
`~/.hivemnd/config.json` remains valid and is referenced, not rewritten, when
the registry is created. Override the state directory with `HIVEMND_HOME`.
`HIVEMND_CONFIG` and `--config` preserve the exact-config workflow and are
mutually exclusive with `--org`.

`hivemnd init` is the recommended onboarding path. Paste the activation URL
from the portal when prompted; the one-time token is captured without echoing
it. Hivemnd previews the organization, every enabled AI tool, selected scopes,
canonical workspace folders and automatic synchronization before changing
anything. It then authenticates, commits the tenant profile and routing under an
exclusive local lock, performs the first fail-safe sync when destinations exist,
registers the Hivemnd MCP proxy and verified `SessionStart` context hook for the
selected scopes, and optionally installs automatic sync. A later activation URL
can add another organization. Headless
use requires explicit flags and `--apply`; provide the activation URL through
`HIVEMND_ACTIVATION_URL` instead of process arguments when possible.

Use `hivemnd org list` to inspect local aliases and bindings. When several
organizations are available, run the command in a connected workspace or pass
an explicit alias:

```sh
hivemnd --org acme status
hivemnd --org acme sync --all --apply
```

A canonical workspace belongs to exactly one organization. Codex and Claude
Code can each have at most one global organization. Replacing a global binding
requires interactive confirmation or `--replace-global`; modified
Hivemnd-owned files block replacement.

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

Manifest delivery scopes are semantic: `user` targets are eligible for `root`
and `directory` destinations, while `workspace` targets are eligible only for
`workspace` destinations. A direct `directory` is an exact agent root, not a
workspace, and does not receive a session hook.

Manage destinations without editing JSON directly:

```sh
hivemnd config destination add api-codex \
  --agent codex --scope workspace --path /absolute/path/to/api
hivemnd config destination remove api-codex
hivemnd config show
```

For the common workspace flow, use the shorter idempotent command. It resolves
the folder to an existing canonical directory and adds all AI tools enabled by
the organization; repeat `--client` to choose an explicit subset.

```sh
hivemnd workspace add . --apply
hivemnd workspace add ../api --org acme --client codex --apply
hivemnd workspace remove ../api --apply
hivemnd workspace list
hivemnd workspace reassign . --org acme --apply
```

`workspace add` previews the host configuration paths it will touch. Interactive
use confirms the preview; headless use requires `--apply`. The workspace
binding, destinations, MCP registrations and `SessionStart` hooks are committed
together and local configuration is restored if registration fails.
`workspace remove` deletes only exact Hivemnd-owned artifacts and managed host
entries. `workspace reassign` validates the target, moves registrations and
synchronizes it within the same rollback boundary.

Synchronize every configured destination, one destination, or a selected set:

```sh
hivemnd sync --all --apply
hivemnd sync --apply .
hivemnd sync --destination api-codex --apply
hivemnd sync --destination api-codex --destination web-claude --apply
```

Without `--all` or `--destination`, `sync [path]` chooses the most-specific
configured workspace containing that path (the current directory by default),
then falls back to global destinations. `--all` preserves the former behavior
of synchronizing every destination. Existing scheduled commands that explicitly
pass `--config` remain compatible.

Running the command again fetches the latest authorized release, compares it
with the local ownership ledgers, and applies only required changes. There is no
persistent MCP process. To run the same synchronization
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
`<node> <cli-script> --config <absolute-path> sync --all --apply`. This avoids relying
on a shell, inherited `PATH`, or the npm bin shim's `/usr/bin/env node` shebang.
It stores no token. Logs and minimal scheduler metadata live under
`$HIVEMND_HOME/logs` and `$HIVEMND_HOME/schedules` (normally `~/.hivemnd`) with
private permissions. Automatic synchronization is installed only when the
credential is available from persistent secure storage. macOS uses Keychain;
Linux onboarding therefore skips automatic synchronization until an equivalent
secure persistent credential adapter is configured. Tokens are never written
to the schedule or config.

An `active` schedule means the operating system loaded its timer; it does not
guarantee that the last sync succeeded. `hivemnd schedule status` reports
`last run failed` and the exact private error-log path when launchd or systemd
records a failed execution. On macOS, workspaces under protected `Desktop` or
`Documents` folders may require granting Full Disk Access to the exact Node
runtime used by the schedule (inspect it with `node -p 'process.execPath'`). Do
not weaken folder permissions to work around TCC; grant access deliberately,
run the schedule again, and review both status and its reported error log.

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

## MCP connection

`init` and `workspace add` register a stdio command for enabled AI tools. Codex
or Claude Code starts `hivemnd mcp serve` as a child process for its session; it
is not a daemon. The proxy resolves the tenant from the workspace or client
global binding, reads its credential from secure storage and forwards MCP
JSON-RPC to Rails. Backend `initialize` instructions, tool descriptions and
schemas remain canonical.

Authenticated API and MCP requests advertise the running strict-SemVer version
through `Hivemnd-Client-Version`. A non-empty allowlisted feature set is sent
through `Hivemnd-Client-Features`; the current exact-target feature is
`exact-delivery-targets-v1`. Both headers are bounded protocol metadata. They
contain no paths, prompts, artifact content or authority claims, and technical
features never create or reactivate server-owned capability grants. The MCP
JSON-RPC body is forwarded unchanged.

```sh
hivemnd mcp status --client codex --workspace .
hivemnd mcp status --client claude --workspace .
```

Codex uses `~/.codex/config.toml` globally and `<workspace>/.codex/config.toml`
for workspace scope. Claude Code uses its user configuration for global and
private workspace scopes; committed `.mcp.json` project scope is explicit.
Registrations contain absolute Node and CLI paths, never activation URLs or
bearer tokens, and Hivemnd changes only its owned entry.

## Always-on organization context

Authorized embedded documents under `context/<slug>.md` are not copied into
workspace `.agents/context` or `.claude/context` directories, and their bodies
are not appended to `AGENTS.md` or `CLAUDE.md`. Synchronization writes one
private, versioned cache per organization:

```text
$HIVEMND_HOME/organizations/<organization-key>/always-context/
  current.json
  versions/<artifact-version-hash>.md
```

Cache manifest v2 records exact artifact-version IDs, delivery targets, the
effective byte limit, sizes and SHA-256 hashes. It filters `user` context for a
global hook and `workspace` context for a workspace hook. Cache v1 remains
readable during migration but has only client kinds, so it is deliberately
treated as legacy `any` scope until the next successful apply writes v2.
Directories use mode `0700`, files use `0600`, version files are immutable and
pointer updates are atomic. Invalid metadata, unsafe files, hash or size drift,
invalid UTF-8 and oversized output fail closed; policy context is never
silently truncated.

The backend-advertised context limit is capped locally at 10,000 rendered UTF-8
bytes for every client-and-scope cohort. Accounting includes one managed newline
between selected documents and no trailing newline added by v2. Exactly the
limit succeeds; exceeding it leaves the active pointer unchanged.

Codex loads the cache from an owned `SessionStart` entry in
`~/.codex/hooks.json` or `<workspace>/.codex/hooks.json`; Hivemnd never registers
`SubagentStart`. Claude Code uses `~/.claude/settings.json` or private
`<workspace>/.claude/settings.local.json`, and the injector emits nothing when
Claude supplies an `agent_id`. Both hooks match `startup`, `resume`, `clear` and
`compact` so context survives resumed and compacted primary sessions.

Every managed hook declares whether it is global or belongs to one canonical
workspace. If hosts execute global, workspace and nested-workspace hooks for the
same session, only the hook for the most specific effective workspace binding
emits; ancestor and global hooks stay silent. Outside a bound workspace only the
effective global hook emits. Codex's inline-context threshold is 12,000 tokens,
above Hivemnd's hard 10,000-byte output cap, so verified context cannot spill to
a temporary file.

At hook time the CLI reads only the hook payload, organization registry and
verified local cache. It performs no MCP call, network request or credential
lookup. Workspace bindings take precedence over each client's global binding.
Unrelated hooks and user configuration are preserved. During migration an old
managed block is removed from `AGENTS.md` or `CLAUDE.md` only when its ownership
record and exact hash still match; unowned marker text is untouched.

## Company sources

`hivemnd sources list` calls `GET /api/v1/sources` and displays only the sources
and effective actions authorized by the backend, including PostgreSQL databases
and GitHub repositories. `hivemnd sources inspect SOURCE_UUID` remains specific
to PostgreSQL: it calls `GET /api/v1/sources/:id/schema` and prints the ordered
schemas, tables and columns returned by the server. GitHub repository reads use
the governed MCP `list_tree` and `read_file` actions instead of a CLI content
command.

The CLI validates both responses strictly. It does not connect to customer
databases or apply client-side authorization. Query execution remains an MCP and
backend responsibility, not a CLI feature.

## Synchronization safety

- Dry-run is the default; local writes require `--apply`.
- Manifests are schema- and expiry-checked. A manifest's required
  `minimum_client_version` is validated as SemVer and enforced before any
  artifact download, ownership read, plan or write. Each exact delivery target
  may also declare a bounded strict-SemVer minimum; only a minimum applicable to
  a selected local destination or effective hook cohort blocks synchronization,
  and it blocks at the same pre-download boundary. Downloads are size- and
  SHA-256-checked before planning begins.
- During the additive compatibility window, artifacts without
  `delivery_targets` normalize their legacy `targets` to `any` scope. This is
  intentionally broad and must not be described as exact-scope enforcement.
  When exact targets are present, their client kinds must agree with the sorted
  legacy list and assignments are planned only for matching client and scope.
- Remote content paths must remain on the configured Hivemnd origin.
- Destination paths must remain inside their configured root and cannot traverse
  symlinks or the reserved `.hivemnd` namespace.
- Existing unmanaged files and locally modified managed files become conflicts;
  they are never overwritten or claimed silently.
- Writes use private temporary files and atomic rename. A failed multi-
  destination apply restores files, every affected ownership ledger and the
  active always-context pointer.
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

## Exact-delivery rollout and rollback

Use this order when enabling exact delivery in an environment:

1. Deploy the additive backend response while legacy `targets` remains present,
   and freeze publications whose safety depends on exact scope or per-target
   minimums.
2. Release and observe a compatible CLI with dual parsing, cache v2 and
   `exact-delivery-targets-v1` negotiation.
3. Raise the backend's global minimum CLI version to that compatible release.
4. Only then enable exact-scope enforcement and lift the publication freeze.

To roll back before enforcement, disable exact response negotiation while
retaining immutable target rows and the legacy list. After organizations rely
on scoped delivery, do not lower the global minimum or restore legacy broad
planning unless operators explicitly accept and communicate that loss of scope
isolation. A cache v1 already on disk remains broad until a successful v2 sync;
rollback never rewrites user-owned files.

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
