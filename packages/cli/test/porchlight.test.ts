import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
