# Porchlight

Porchlight gives each dev server, service, and folder on one machine its own HTTPS URL on a domain the user owns. Every device on the user's private network can reach those URLs. The public internet can't.

## Language

### Porches

**Porch**:
One named URL, `https://<porch name>.<domain>`. It exists whether or not anything answers behind it.
_Avoid_: route, site, host, subdomain

**Porch name**:
The single DNS label in front of the domain, such as `ristretto`. Always one label, because the wildcard certificate covers only one level.
_Avoid_: subdomain, slug

**Upstream**:
What a porch forwards to: a local port, an address on another machine, or a folder.
_Avoid_: backend, target, origin

**Lit**:
A porch whose upstream answers.
_Avoid_: up, live, running

**Dark**:
A porch whose upstream doesn't answer. The porch still exists and still has its URL.
_Avoid_: down, broken, offline

**Dark page**:
The page a dark porch shows. It names the porch and says how to light it.
_Avoid_: error page, 502 page

**Fallback page**:
The page shown for a name under the domain that has no porch. Different from a dark page: there is nothing to light.
_Avoid_: 404 page, default route

### Porch kinds

**Dev porch**:
A porch for a dev server on this machine, on a leased port.

**Service porch**:
A porch for anything with an address, on this machine or another.
_Avoid_: proxy porch

**Static porch**:
A porch that serves a folder as files.

**Artifacts porch**:
The one porch that serves the artifacts folder, where published files land.

**Artifact**:
A single file, usually HTML an agent wrote, published into the artifacts folder under a project slug.
_Avoid_: upload, plan

**Worktree porch**:
A short-lived dev porch for a linked git worktree, named `<worktree>--<project>`. It goes away with the worktree.
_Avoid_: branch porch, preview

### Ports

**Lease**:
The permanent assignment of one port to one dev porch. A porch keeps its lease until it is removed, so URLs, OAuth callbacks, and `.env` files never shift.
_Avoid_: allocation, reservation, assignment

**Port range**:
The ports porch leases from on this machine.

### State

**Registry**:
Every porch on this machine. It is the single source of truth for what the snippet contains.
_Avoid_: routes file, route table

**Machine config**:
The per-machine settings: domain, port range, the artifacts folder, and the proxy: which kind, where the snippet goes, and the reload command.
_Avoid_: global config, settings

**Proxy**:
The reverse proxy the user runs and owns, which serves the porches. Caddy first. Porch never installs, starts, or configures it beyond the snippet.
_Avoid_: server, gateway, porch's Caddy

**Snippet**:
The file porch renders from the registry for the proxy to import. The user's own proxy config includes it with one line. It is the only thing porch writes for the proxy.
_Avoid_: config, Caddyfile, routes

**Project config**:
Optional settings a project carries to choose its porch name or pin its port.
_Avoid_: local config

**Apply**:
Rendering the snippet from the registry, validating it, writing it, and asking the proxy to reload. Either all of it takes effect or none of it does, because the proxy refuses a bad config and keeps serving the old one.
_Avoid_: sync, deploy

**Rollback**:
Applying an earlier registry again.
_Avoid_: undo, revert

## Relationships

- A **porch** has exactly one **porch name** and one **upstream**, and is always **lit** or **dark**.
- A **dev porch** holds exactly one **lease**. A **worktree porch** is a **dev porch**.
- The **registry** holds every **porch**. **Apply** turns the **registry** plus the **machine config** into the **snippet**, and the **proxy** serves what the **snippet** says.
- A dark **porch** shows its **dark page**. A name with no **porch** shows the **fallback page**.
