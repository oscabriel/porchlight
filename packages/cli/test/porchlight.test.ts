import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openPorchlight } from "../src/porchlight.ts";
import type { MachineConfig } from "../src/schema.ts";
import { startCaddy } from "./support/caddy.ts";
import type { TestCaddy } from "./support/caddy.ts";
import { selfSigned } from "./support/tls.ts";

let caddy: TestCaddy;
let stateDir: string;
const servers: { stop: (force?: boolean) => unknown }[] = [];

const machine = (): MachineConfig => ({
	artifacts: path.join(stateDir, "artifacts"),
	domain: "porch.test",
	ports: { range: [3001, 3999] },
	proxy: { config: caddy.caddyfile, dir: caddy.snippetDir, kind: "caddy", reload: caddy.reload },
});

beforeAll(async () => {
	caddy = await startCaddy();
});
afterAll(async () => {
	await caddy.stop();
});
beforeEach(async () => {
	stateDir = await mkdtemp(path.join(tmpdir(), "porch-state-"));
	// Caddy still serves the previous test's snippet. Start each test from none.
	await openPorchlight({ config: machine(), stateDir }).apply();
});
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
	await rm(stateDir, { force: true, recursive: true });
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

test("reserved names are refused for new porches, but an imported Caddy config keeps them", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });

	for (const name of ["www", "app", "admin", "api", "plans"]) {
		// eslint-disable-next-line no-await-in-loop -- each refusal is its own case
		await expect(porch.add(name, upstream("never"))).rejects.toThrow(`${name} is reserved`);
	}
	await expect(porch.serve("www", stateDir)).rejects.toThrow("www is reserved");
	expect(await porch.list()).toEqual({});

	await porch.adopt({ plans: { kind: "artifacts" }, www: { kind: "static", root: stateDir } });
	expect(Object.keys(await porch.list()).toSorted()).toEqual(["plans", "www"]);
});

test("adding a name that's already a porch is refused and the first porch keeps its upstream", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("first"));

	await expect(porch.add("tv", upstream("second"))).rejects.toThrow("tv is already a porch");

	expect((await caddy.get("tv.porch.test")).body).toBe("first");
});

test("when Caddy refuses to reload, porch says why, puts the old snippet back, and the registry doesn't change", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("hello from tv"));
	await caddy.writeCaddyfile("\tnot_a_directive\n");
	try {
		await expect(porch.add("books", upstream("never"))).rejects.toThrow(
			/caddy refused to reload, so nothing changed[^]*not_a_directive/u,
		);
	} finally {
		await caddy.writeCaddyfile();
	}

	expect(Object.keys(await porch.list())).toEqual(["tv"]);
	const snippet = await Bun.file(path.join(caddy.snippetDir, "porches.caddy")).text();
	expect(snippet).toContain("@tv host tv.porch.test");
	expect(snippet).not.toContain("books");
	expect((await caddy.get("tv.porch.test")).body).toBe("hello from tv");
});

test("without a reload command, porch writes the snippet and reports that Caddy wasn't reloaded", async () => {
	const config = { ...machine(), proxy: { ...machine().proxy, reload: undefined } };
	const porch = openPorchlight({ config, stateDir });

	expect(await porch.add("tv", upstream("hello from tv"))).toEqual({ reloaded: false });

	expect(await Bun.file(path.join(caddy.snippetDir, "porches.caddy")).text()).toContain(
		"@tv host tv.porch.test",
	);
	expect((await caddy.get("tv.porch.test")).status).toBe(404);
	expect(await openPorchlight({ config: machine(), stateDir }).apply()).toEqual({
		reloaded: true,
	});
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

test("apply writes the snippet again after it was deleted", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("tv"));
	await Promise.all(
		["porches.caddy", "errors.caddy", "fallback.caddy"].map((file) =>
			rm(path.join(caddy.snippetDir, file)),
		),
	);

	await porch.apply();

	expect((await caddy.get("tv.porch.test")).body).toBe("tv");
	expect((await caddy.get("nobody.porch.test")).status).toBe(404);
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

test("status reports each porch as lit or dark", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("tv"));
	await porch.add("books", upstream("books"));
	servers.pop()?.stop(true);
	const site = path.join(stateDir, "site");
	await mkdir(site);
	await porch.serve("depot", site);
	await porch.serve("gone", path.join(stateDir, "missing"));

	const status = await porch.status();

	expect(status.map(({ name, state, url }) => ({ name, state, url }))).toEqual([
		{ name: "books", state: "dark", url: "https://books.porch.test" },
		{ name: "depot", state: "lit", url: "https://depot.porch.test" },
		{ name: "gone", state: "dark", url: "https://gone.porch.test" },
		{ name: "tv", state: "lit", url: "https://tv.porch.test" },
	]);
});

test("adopt adds a set of porches in one apply, or none if any name is taken", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("tv"));

	await expect(
		porch.adopt({
			books: { kind: "service", upstream: upstream("books") },
			tv: { kind: "service", upstream: upstream("other") },
		}),
	).rejects.toThrow("tv is already a porch");
	expect(Object.keys(await porch.list())).toEqual(["tv"]);

	await porch.adopt({
		books: { kind: "service", upstream: upstream("books") },
		movies: { kind: "service", upstream: upstream("movies") },
	});
	expect((await caddy.get("books.porch.test")).body).toBe("books");
	expect((await caddy.get("movies.porch.test")).body).toBe("movies");
});

const portOf = (url: string) => Number(new URL(url).port);

test("a dev porch forwards to its port, and split paths go to the second port", async () => {
	const web = portOf(upstream("web"));
	const api = portOf(upstream("api"));
	const porch = openPorchlight({ config: machine(), stateDir });

	await porch.adopt({
		thinkspace: {
			kind: "dev",
			port: web,
			split: [
				{ paths: ["/rpc*"], port: api },
				{ method: "POST", paths: ["/ai"], port: api },
			],
		},
	});

	expect((await caddy.get("thinkspace.porch.test", "/")).body).toBe("web");
	expect((await caddy.get("thinkspace.porch.test", "/rpc/list")).body).toBe("api");
	expect((await caddy.get("thinkspace.porch.test", "/ai")).body).toBe("web");
});

test("a dark dev porch says where to run its start command", async () => {
	const url = upstream("soon gone");
	servers.pop()?.stop(true);
	const porch = openPorchlight({ config: machine(), stateDir });

	await porch.adopt({
		ristretto: {
			kind: "dev",
			port: portOf(url),
			project: "~/Developer/projects/ristretto",
			start: "bun run dev",
		},
	});

	const res = await caddy.get("ristretto.porch.test");
	expect(res.status).toBe(502);
	expect(res.body).toContain("ristretto is dark");
	expect(res.body).toContain(
		"<code>bun run dev</code> in <code>~/Developer/projects/ristretto</code>",
	);
});

test("a service porch can redirect a path before forwarding", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });

	await porch.adopt({
		dns: { kind: "service", redirect: { "/": "/admin/" }, upstream: upstream("pihole") },
	});

	expect((await caddy.headers("dns.porch.test", "/")).location).toBe("/admin/");
	expect((await caddy.get("dns.porch.test", "/")).status).toBe(308);
	expect((await caddy.get("dns.porch.test", "/admin/")).body).toBe("pihole");
});

test("a service porch can forward to an https upstream", async () => {
	const tls = Bun.serve({
		fetch: () => new Response("over tls"),
		hostname: "127.0.0.1",
		port: 0,
		tls: await selfSigned(),
	});
	servers.push(tls);
	const porch = openPorchlight({ config: machine(), stateDir });

	await porch.add("nas", `https://127.0.0.1:${tls.port}`);

	expect(await caddy.get("nas.porch.test")).toEqual({ body: "over tls", status: 200 });
});

test("responses are compressed when the client accepts it", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("x".repeat(4096)));

	expect(
		(await caddy.headers("tv.porch.test", "/", ["Accept-Encoding: zstd, gzip"]))[
			"content-encoding"
		],
	).toBe("zstd");
});

test("static porches list folders without an index, and noCache asks browsers to revalidate", async () => {
	const root = path.join(stateDir, "depot");
	await mkdir(path.join(root, "lessons"), { recursive: true });
	await writeFile(path.join(root, "lessons", "one.html"), "lesson one");
	const porch = openPorchlight({ config: machine(), stateDir });

	await porch.adopt({ depot: { kind: "static", noCache: true, root } });

	const listing = await caddy.get("depot.porch.test", "/lessons/", ["Accept: text/html"]);
	expect(listing.status).toBe(200);
	expect(listing.body).toContain("one.html");
	expect((await caddy.headers("depot.porch.test", "/lessons/one.html"))["cache-control"]).toBe(
		"no-cache",
	);
});

test("the artifacts porch serves the machine's artifacts folder", async () => {
	const config = machine();
	await mkdir(path.join(config.artifacts, "porchlight"), { recursive: true });
	await writeFile(path.join(config.artifacts, "porchlight", "plan.html"), "the plan");
	const porch = openPorchlight({ config, stateDir });

	await porch.adopt({ plans: { kind: "artifacts" } });

	expect(await caddy.get("plans.porch.test", "/porchlight/plan.html")).toEqual({
		body: "the plan",
		status: 200,
	});
	expect((await caddy.get("plans.porch.test", "/porchlight/")).body).toContain("plan.html");
});

test("docs renders the porches as Markdown tables, services first, then dev servers", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.adopt({
		depot: { about: "Lesson files", kind: "static", label: "Teach Depot", root: stateDir },
		ristretto: { kind: "dev", port: 3001 },
		thinkspace: {
			kind: "dev",
			label: "Thinkspace",
			port: 3002,
			split: [{ paths: ["/rpc*"], port: 3003 }],
		},
		watch: {
			about: "Media streaming",
			kind: "service",
			label: "Jellyfin",
			upstream: "http://127.0.0.1:8096",
		},
	});

	expect(await porch.docs()).toBe(`| Service | URL | Purpose |
|---------|-----|---------|
| Teach Depot | https://depot.porch.test | Lesson files |
| Jellyfin | https://watch.porch.test | Media streaming |

| Project | URL | Port(s) |
|---------|-----|---------|
| ristretto | https://ristretto.porch.test | 3001 |
| Thinkspace | https://thinkspace.porch.test | 3002, 3003 |
`);
});

test("check fetches every porch through Caddy with the certificate verified", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.add("tv", upstream("tv"));
	await porch.add("gone", upstream("gone"));
	servers.pop()?.stop(true);

	const served = await porch.check({
		ca: await caddy.rootCa(),
		port: caddy.httpsPort,
		waitMs: 5000,
	});

	expect(served).toEqual([
		{ name: "gone", status: 502 },
		{ name: "tv", status: 200 },
	]);
});

test("the snippet is a Caddyfile a person can read: one matcher and handle per porch, dark pages in one block", async () => {
	const porch = openPorchlight({ config: machine(), stateDir });
	await porch.adopt({
		ristretto: { kind: "dev", port: 3001, project: "~/x", start: "bun run dev" },
		tv: { kind: "service", upstream: "http://192.168.1.10:8989" },
	});

	const snippet = await porch.render();

	expect(snippet["porches.caddy"]).toContain(`@ristretto host ristretto.porch.test
handle @ristretto {
	reverse_proxy 127.0.0.1:3001
}
@tv host tv.porch.test
handle @tv {
	reverse_proxy 192.168.1.10:8989
}`);
	expect(snippet["errors.caddy"]).toContain("handle_errors 502 504 {");
	expect(snippet["errors.caddy"]).toContain(
		'ristretto.porch.test ristretto http://127.0.0.1:3001 "Start it with <code>bun run dev</code> in <code>~/x</code>."',
	);
	expect(snippet["fallback.caddy"]).toContain("HTML 404");
});
