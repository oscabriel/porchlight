# Porchlight

Give every dev server, self-hosted service, and folder of agent-written HTML on your machine its own `https://<name>.<your-domain>` URL. Each one gets a real wildcard certificate and is reachable from your laptop and phone over Tailscale or your LAN. Nothing is exposed to the public internet.

```sh
porch run bun run dev                     # https://myapp.example.com, port leased for you
porch add jellyfin http://localhost:8096  # https://jellyfin.example.com
porch serve docs ./site                   # https://docs.example.com
porch publish report.html                 # https://plans.example.com/<project>/report.html
```

Porchlight works with the [Caddy](https://caddyserver.com) you already run. It keeps a registry of porches and renders it as a Caddyfile snippet, which your Caddyfile imports with one line inside its `*.example.com` block. After each change porch runs the reload command you gave it. Caddy refuses a bad config and keeps serving the old one, so a change either lands whole or not at all. Porch installs nothing, owns no process or port, and stores no secrets. TLS, the wildcard certificate, your DNS plugin, Docker or systemd, and every service you wrote by hand stay yours.

A porch whose server isn't running shows a page saying how to start it, instead of a bare 502. `porch ls` says which porches are lit and which are dark. `porch docs` renders the URL table your notes keep, so it can't drift.

It's for people whose browser and dev server run on different machines: a home server, a cloud VM, a box an agent works on overnight.

## Setup

1. `porch init`. It asks for your domain, finds your private address (Tailscale when you have it), checks that `*.example.com` points at it, finds your Caddyfile, and writes the snippet. With no Caddyfile yet it writes a starter one that gets a wildcard certificate over Cloudflare DNS.
2. Add the lines it prints inside your `*.example.com` block, and reload Caddy once.
3. `porch import caddy --from /etc/caddy/Caddyfile` brings in the hosts you already have, or leave them where they are. Hand-written handles and porch's snippet live side by side.

**Status:** pre-alpha. The core commands (`init`, `add`, `serve`, `rm`, `ls`, `url`, `docs`, `apply`, `rollback`, `import caddy`, `doctor`) work. `porch run`, `porch publish`, and the Vite plugin aren't built yet. Caddy is the only proxy porch renders for today. The renderer is a seam, and Traefik's file provider is the next target.

## License

MIT
