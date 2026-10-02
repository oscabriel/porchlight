# Porchlight

`porch` CLI (`packages/cli`, published as `porchlight`) and Vite plugin (`packages/vite`, published as `@porchlight/vite`). Bun workspace. The scripts in `package.json` cover test, types, lint, format, and schema generation.

- **Vocabulary.** Read `CONTEXT.md` before naming anything. Code, tests, CLI output, and docs say porch, lit, dark, lease, registry, snippet, and proxy, never route, up, down, allocation, or "porch's Caddy".
- **Design.** The design and settled decisions live outside the repo, in the maintainer's vault at `~/Documents/sync-vault/projects/minilab/decisions/2026-10-porchlight-design.md`. Read it before changing scope, file shapes, or the command set. Its last section, "the inversion", supersedes the "Mechanism" and "Files" sections above it.
- **The proxy is the user's.** Porch writes snippet files into `proxy.dir` and runs `proxy.reload`. It never installs Caddy, writes a unit, binds a port, stores a token, or calls the admin API to change anything. `caddy-admin.ts` only reads a config for `porch import`.
- **Schemas.** `packages/cli/src/schema.ts` is the source of truth. `packages/cli/schema/*.json` is generated from it with `bun run schema`, and you commit the result. Never hand-edit the generated JSON.
- **Tests run against a throwaway Caddy** started from a Caddyfile that imports the snippet, on high loopback ports only (`test/support/caddy.ts`). Linux `SO_REUSEPORT` lets a second Caddy bind `:443` next to a live one without error, and the kernel then splits real traffic between them. Never point a test at the machine's real Caddyfile, `:443`, or a real admin address.
- **The snippet lives inside the user's wildcard site block.** It is `@name host` matchers and `handle` blocks, imported with `import`. Anything that only works at the top level of a Caddyfile, or that would collide with the user's own directives (a catch-all `handle`, `handle_errors` for the same status codes), can't go in `porches.caddy`.
- **Framework integration is env vars only.** `porch run` never rewrites a command's flags.
