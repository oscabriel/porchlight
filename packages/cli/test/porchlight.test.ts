import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openPorchlight } from "../src/porchlight.ts";
import type { MachineConfig } from "../src/schema.ts";
import { startCaddy } from "./support/caddy.ts";
import type { TestCaddy } from "./support/caddy.ts";

let caddy: TestCaddy;
let stateDir: string;
const servers: { stop: (force?: boolean) => unknown }[] = [];

beforeAll(async () => {
	caddy = await startCaddy();
});
afterAll(async () => {
	await caddy.stop();
});
beforeEach(async () => {
	stateDir = await mkdtemp(path.join(tmpdir(), "porch-state-"));
});
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
	await rm(stateDir, { force: true, recursive: true });
});

const machine = (): MachineConfig => ({
	acmeEmail: "admin@porch.test",
	artifacts: path.join(stateDir, "artifacts"),
	caddy: { admin: caddy.admin, listen: [`127.0.0.1:${caddy.httpsPort}`], managed: false },
	dns: { provider: "cloudflare", tokenEnv: "UNUSED" },
	domain: "porch.test",
	network: "tailscale",
	ports: { range: [3001, 3999] },
	tls: { issuer: "internal" },
});

const upstream = (body: string) => {
	const server = Bun.serve({ fetch: () => new Response(body), hostname: "127.0.0.1", port: 0 });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
};

test("a service porch forwards to its upstream over HTTPS", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });

	await porch.add("tv", upstream("hello from tv"));

	expect(await caddy.get("tv.porch.test")).toEqual({ body: "hello from tv", status: 200 });
});

test("a name with no porch shows the fallback page", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("hello from tv"));

	const res = await caddy.get("nobody.porch.test");

	expect(res.status).toBe(404);
	expect(res.body).toContain("There is no porch at nobody.porch.test");
});

test("a porch whose upstream doesn't answer shows its dark page", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	const url = upstream("soon gone");
	await porch.add("tv", url);
	servers.pop()?.stop(true);

	const res = await caddy.get("tv.porch.test");

	expect(res.status).toBe(502);
	expect(res.body).toContain("tv is dark");
	expect(res.body).toContain(url);
});

test("a name that isn't one DNS label is refused and the live porches keep serving", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("hello from tv"));

	await expect(porch.add("my.app", upstream("never"))).rejects.toThrow(
		'"my.app" is not a valid porch name',
	);
	await expect(porch.add("Tv", upstream("never"))).rejects.toThrow("not a valid porch name");

	expect(await caddy.get("tv.porch.test")).toEqual({ body: "hello from tv", status: 200 });
	expect(await porch.list()).toEqual({ tv: expect.objectContaining({ kind: "service" }) });
});

test("adding a name that's already a porch is refused and the first porch keeps its upstream", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("first"));

	await expect(porch.add("tv", upstream("second"))).rejects.toThrow("tv is already a porch");

	expect((await caddy.get("tv.porch.test")).body).toBe("first");
});

test("when Caddy rejects the config, porch reports it and neither Caddy nor the registry changes", async () => {
	await openPorchlight({ config: machine(), stateDir }).add("tv", upstream("hello from tv"));
	// Stock Caddy has no Cloudflare DNS module, so an acme issuer fails to load.
	const acme = openPorchlight({ config: { ...machine(), tls: { issuer: "acme" } }, stateDir });

	await expect(acme.add("books", upstream("never"))).rejects.toThrow(
		/Caddy rejected the config: .*dns\.providers\.cloudflare/u,
	);

	expect(Object.keys(await acme.list())).toEqual(["tv"]);
	expect((await caddy.get("tv.porch.test")).body).toBe("hello from tv");
});

test("two porch processes adding at once both land", async () => {
	const first = openPorchlight({ config: machine(), stateDir });
	const second = openPorchlight({ config: machine(), stateDir });

	await Promise.all([first.add("tv", upstream("tv")), second.add("books", upstream("books"))]);

	expect(Object.keys(await first.list()).toSorted()).toEqual(["books", "tv"]);
	expect((await caddy.get("tv.porch.test")).body).toBe("tv");
	expect((await caddy.get("books.porch.test")).body).toBe("books");
});

test("a removed porch falls through to the fallback page", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("tv"));
	await porch.add("books", upstream("books"));

	await porch.rm("tv");

	expect((await caddy.get("tv.porch.test")).status).toBe(404);
	expect((await caddy.get("books.porch.test")).body).toBe("books");
	expect(Object.keys(await porch.list())).toEqual(["books"]);
});

test("removing a name that isn't a porch is refused", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });

	await expect(porch.rm("ghost")).rejects.toThrow("ghost is not a porch");
});

test("a static porch serves a folder and hides .git, .env files, and node_modules", async () => {
	const root = path.join(stateDir, "site");
	await mkdir(path.join(root, ".git"), { recursive: true });
	await mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
	await mkdir(path.join(root, "docs"), { recursive: true });
	await Promise.all([
		writeFile(path.join(root, "index.html"), "home page"),
		writeFile(path.join(root, "docs", "guide.html"), "guide"),
		writeFile(path.join(root, ".env"), "SECRET=1"),
		writeFile(path.join(root, ".env.local"), "SECRET=2"),
		writeFile(path.join(root, ".git", "config"), "[core]"),
		writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports"),
	]);
	const porch = openPorchlight({ config: machine(), stateDir });

	await porch.serve("depot", root);

	expect(await caddy.get("depot.porch.test")).toEqual({ body: "home page", status: 200 });
	expect(await caddy.get("depot.porch.test", "/docs/guide.html")).toEqual({
		body: "guide",
		status: 200,
	});
	for (const hidden of [
		"/.env",
		"/.env.local",
		"/.git/config",
		"/node_modules/left-pad/index.js",
	]) {
		// eslint-disable-next-line no-await-in-loop -- one request at a time reads clearer in a failure
		expect({ hidden, status: (await caddy.get("depot.porch.test", hidden)).status }).toEqual({
			hidden,
			status: 404,
		});
	}
});

test("apply restores every porch after Caddy loses its config", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("tv"));
	// What a Caddy restart without --resume looks like: only the admin endpoint survives.
	const adminOnly = { admin: { listen: new URL(caddy.admin).host } };
	await fetch(`${caddy.admin}/load`, {
		body: JSON.stringify(adminOnly),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});

	await porch.apply();

	expect((await caddy.get("tv.porch.test")).body).toBe("tv");
});

test("rollback steps back through earlier states, one change at a time", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("tv"));
	await porch.add("books", upstream("books"));

	await porch.rollback();
	expect(Object.keys(await porch.list())).toEqual(["tv"]);
	expect((await caddy.get("books.porch.test")).status).toBe(404);
	expect((await caddy.get("tv.porch.test")).body).toBe("tv");

	await porch.rollback();
	expect(await porch.list()).toEqual({});

	await expect(porch.rollback()).rejects.toThrow("Nothing to roll back to");
});

test("rollback restores a config porch didn't write, such as Caddy's config before porch took over", async () => {
	const before = {
		admin: { listen: new URL(caddy.admin).host },
		apps: {
			http: {
				servers: {
					old: {
						automatic_https: { disable_redirects: true },
						listen: [`127.0.0.1:${caddy.httpsPort}`],
						routes: [
							{
								handle: [{ body: "old setup", handler: "static_response" }],
								match: [{ host: ["old.porch.test"] }],
							},
						],
					},
				},
			},
			pki: { certificate_authorities: { local: { install_trust: false } } },
			tls: {
				automation: {
					policies: [{ issuers: [{ module: "internal" }], subjects: ["old.porch.test"] }],
				},
			},
		},
	};
	const loaded = await fetch(`${caddy.admin}/load`, {
		body: JSON.stringify(before),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	expect(loaded.status).toBe(200);
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("tv"));

	await porch.rollback();

	expect(await caddy.get("old.porch.test")).toEqual({ body: "old setup", status: 200 });
});
