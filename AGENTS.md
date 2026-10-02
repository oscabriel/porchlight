# Porchlight

`porch` CLI (`packages/cli`, published as `porchlight`) and Vite plugin (`packages/vite`, published as `@porchlight/vite`). Bun workspace. The scripts in `package.json` cover test, types, lint, format, and schema generation.

- **Vocabulary.** Read `CONTEXT.md` before naming anything. Code, tests, CLI output, and docs say porch, lit, dark, lease, and registry, never route, up, down, or allocation.
- **Design.** The design and settled decisions live outside the repo, in the maintainer's vault at `~/Documents/sync-vault/projects/minilab/decisions/2026-10-porchlight-design.md`. Read it before changing scope, file shapes, or the command set.
- **Schemas.** `packages/cli/src/schema.ts` is the source of truth. `packages/cli/schema/*.json` is generated from it with `bun run schema`, and you commit the result. Never hand-edit the generated JSON.
- **Tests run against a throwaway Caddy.** It listens on high loopback ports only. Linux `SO_REUSEPORT` lets a second Caddy bind `:443` next to a live one without error, and the kernel then splits real traffic between them. Point tests at the machine's real Caddy admin endpoint (`127.0.0.1:2019`) and you overwrite the live proxy.
- **Replacing Caddy config.** Use `POST /config/` with `If-Match` set to the ETag from `GET /config/`. `POST /load` ignores `If-Match`, so two `porch` processes could silently overwrite each other.
- **Framework integration is env vars only.** `porch run` never rewrites a command's flags.
