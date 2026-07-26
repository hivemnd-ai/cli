# Hivemnd CLI development contract

## Architecture

- Keep commands thin. Business behavior belongs in ports and adapters under `src/`.
- Codex and Claude integrations must implement neutral agent interfaces. Confirm official lifecycle contracts before encoding paths or installation behavior.
- Keep authentication behind `TokenStore`; never persist credentials in the repository or ordinary config files.
- Synchronization is dry-run by default. Any local mutation requires an explicit `--apply` flag.
- Treat remote content as untrusted: validate schemas, hashes, and destination boundaries before writing.

## Quality gates

- Write behavior-focused tests first for substantial changes.
- Prefer integration flows over isolated implementation tests.
- Tests may only write within per-test temporary directories.
- Maintain 100% coverage of application code; configuration and the executable shim are excluded.
- Before handing off changes, run `npm run check` and `npm audit`.
