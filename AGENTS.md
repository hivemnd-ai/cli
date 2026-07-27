# Hivemnd CLI development contract

## Architecture

- Keep commands thin. Business behavior belongs in ports and adapters under `src/`.
- Codex and Claude integrations must implement neutral agent interfaces. Confirm official lifecycle contracts before encoding paths or installation behavior.
- Keep authentication behind `TokenStore`; never persist credentials in the repository or ordinary config files.
- Synchronization is dry-run by default. Any local mutation requires an explicit `--apply` flag.
- Treat remote content as untrusted: validate schemas, hashes, and destination boundaries before writing.
- Enforce a manifest's `minimum_client_version` before downloading artifacts or preparing a synchronization plan.
- Keep update discovery advisory and non-mutating. Network or cache failures must never break the user's requested command.
- Periodic sync must use native user-level schedulers, the absolute Node runtime and CLI script paths, an absolute config path, and the explicit `sync --apply` command. Never rely on an inherited `PATH` or npm bin shebang. Isolate schedules by tenant plus config, and never persist tokens in scheduler definitions or metadata.
- Scheduler status must distinguish a loaded timer from the result of its last run and point failures to the private error log. Never bypass macOS TCC; document the explicit Full Disk Access boundary for protected workspaces.

## Quality gates

- Write behavior-focused tests first for substantial changes.
- Prefer integration flows over isolated implementation tests.
- Tests may only write within per-test temporary directories.
- Maintain 100% coverage of application code; configuration and the executable shim are excluded.
- Before handing off changes, run `npm run check` and `npm audit`.
