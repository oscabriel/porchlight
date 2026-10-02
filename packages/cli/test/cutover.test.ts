// Moving from a Caddy someone already runs to the one porch manages, the way
// `porch init` does it: import the old config, serve it from the new Caddy on
// a staging port, compare every porch through both, then move the new Caddy
// to the real port with one apply.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCaddyAdmin } from "../src/caddy-admin.ts";
import { importCaddyConfig } from "../src/import.ts";
import { openPorchlight } from "../src/porchlight.ts";
import type { MachineConfig } from "../src/schema.ts";
import { ensureCaddy, freePort, startCaddy } from "./support/caddy.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).toReversed()) {
		// eslint-disable-next-line no-await-in-loop -- tear down in reverse order
		await cleanup();
	}
});

const tempDir = async (prefix: string) => {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { force: true, recursive: true }));
	return dir;
};

const upstream = (body: string) => {
	const server = Bun.serve({ fetch: () => new Response(body), hostname: "127.0.0.1", port: 0 });
	cleanups.push(() => server.stop(true));
	return server.port;
};

/** A hand-written Caddyfile like the ones people already run, loaded through `caddy adapt`. */
const loadCaddyfile = async (admin: string, httpsPort: number, caddyfile: string) => {
	const dir = await tempDir("porch-caddyfile-");
	const file = path.join(dir, "Caddyfile");
	await Bun.write(file, caddyfile);
	const adapt = Bun.spawn([await ensureCaddy(), "adapt", "--config", file], { stdout: "pipe" });
	const adapted = await new Response(adapt.stdout).text();
	expect(await adapt.exited).toBe(0);
	const res = await fetch(`${admin}/load`, {
		body: adapted,
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	expect(res.status).toBe(200);
};

test("porches imported from an old Caddy answer the same through the new one, then move to the real port in one apply", async () => {
	const old = await startCaddy();
	cleanups.push(old.stop);
	const docs = await tempDir("porch-docs-");
	await Bun.write(path.join(docs, "index.html"), "docs");
	await loadCaddyfile(
		old.admin,
		old.httpsPort,
		`{
	admin ${new URL(old.admin).host}
	local_certs
	skip_install_trust
	auto_https disable_redirects
	https_port ${old.httpsPort}
}

*.porch.test {
	@tv host tv.porch.test
	handle @tv {
		reverse_proxy 127.0.0.1:${upstream("tv")}
	}
	@docs host docs.porch.test
	handle @docs {
		root * ${docs}
		file_server
	}
	@gone host gone.porch.test
	handle @gone {
		reverse_proxy 127.0.0.1:${freePort()}
	}
}
`,
	);

	const managed = await startCaddy({ adminSocket: true });
	cleanups.push(managed.stop);
	const stateDir = await tempDir("porch-state-");
	const machine = (listen: string[]): MachineConfig => ({
		acmeEmail: "admin@porch.test",
		artifacts: path.join(stateDir, "artifacts"),
		caddy: { admin: managed.admin, listen, managed: true },
		dns: { provider: "cloudflare", tokenEnv: "UNUSED" },
		domain: "porch.test",
		network: "tailscale",
		ports: { range: [3001, 3999] },
		tls: { issuer: "internal" },
	});
	const staging = machine([`127.0.0.1:${managed.httpsPort}`]);

	const { config: oldConfig } = await createCaddyAdmin(old.admin).current();
	const { porches, skipped } = importCaddyConfig(oldConfig, staging);
	expect(skipped).toEqual([]);
	const porch = openPorchlight({ config: staging, stateDir });
	await porch.adopt(porches);

	const before = await porch.check({ ca: await old.rootCa(), port: old.httpsPort, waitMs: 5000 });
	const after = await porch.check({
		ca: await managed.rootCa(),
		port: managed.httpsPort,
		waitMs: 5000,
	});
	expect(before).toEqual([
		{ name: "docs", status: 200 },
		{ name: "gone", status: 502 },
		{ name: "tv", status: 200 },
	]);
	expect(after).toEqual(before);

	const realPort = freePort();
	const moved = openPorchlight({ config: machine([`127.0.0.1:${realPort}`]), stateDir });
	await moved.apply();

	expect(await moved.check({ ca: await managed.rootCa(), port: realPort, waitMs: 5000 })).toEqual(
		before,
	);
	expect(await moved.check({ ca: await managed.rootCa(), port: managed.httpsPort })).toEqual([
		{ error: expect.any(String), name: "docs" },
		{ error: expect.any(String), name: "gone" },
		{ error: expect.any(String), name: "tv" },
	]);
	expect(await moved.list()).toEqual(porches);
});
