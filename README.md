# Porchlight

Give every dev server, self-hosted service, and folder of agent-written HTML on your machine its own `https://<name>.<your-domain>` URL. Each one gets a real wildcard certificate and is reachable from your laptop and phone over Tailscale. Nothing is exposed to the public internet.

```sh
porch run bun run dev                     # https://myapp.example.com, port leased for you
porch add jellyfin http://localhost:8096  # https://jellyfin.example.com
porch serve docs ./site                   # https://docs.example.com
porch publish report.html                 # https://plans.example.com/<project>/report.html
```

Porchlight drives [Caddy](https://caddyserver.com) through its admin API. It renders the whole config from a JSON registry and swaps it in atomically. If Caddy rejects a config, the old one keeps serving. A porch whose server isn't running shows a page saying how to start it, instead of a bare 502.

It's for people whose browser and dev server run on different machines: a home server, a cloud VM, a box an agent works on overnight.

**Status:** pre-alpha. The core commands (`add`, `serve`, `rm`, `ls`, `url`, `docs`, `apply`, `rollback`, `import caddy`, `doctor`) work against a Caddy you already run. `porch init`, `porch run`, `porch publish`, and the Vite plugin aren't built yet.

## License

MIT
