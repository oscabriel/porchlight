// Bringing the hosts of a hand-written Caddyfile into porch: `porch import
// caddy --from <Caddyfile>` adapts it with the caddy binary, the porches go
// into the registry, and the snippet serves them the same as the old file did.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importCaddyConfig, readCaddyConfig } from "../src/import.ts";
import { openPorchlight } from "../src/porchlight.ts";
import type { MachineConfig } from "../src/schema.ts";
import { freePort, startCaddy, withCaddyOnPath } from "./support/caddy.ts";

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

test("hosts imported from a hand-written Caddyfile answer the same from porch's snippet", async () => {
	await withCaddyOnPath();
	const docs = await tempDir("porch-docs-");
	await Bun.write(path.join(docs, "index.html"), "docs");
	const old = await startCaddy({
		site: `
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
`,
	});
	cleanups.push(old.stop);

	const fresh = await startCaddy();
	cleanups.push(fresh.stop);
	const stateDir = await tempDir("porch-state-");
	const config: MachineConfig = {
		artifacts: path.join(stateDir, "artifacts"),
		domain: "porch.test",
		ports: { range: [3001, 3999] },
		proxy: { config: fresh.caddyfile, dir: fresh.snippetDir, kind: "caddy", reload: fresh.reload },
	};

	const { porches, skipped } = importCaddyConfig(await readCaddyConfig(old.caddyfile), config);
	expect(skipped).toEqual([]);
	expect(Object.keys(porches).toSorted()).toEqual(["docs", "gone", "tv"]);
	const porch = openPorchlight({ config, stateDir });
	await porch.adopt(porches);

	const before = await porch.check({ ca: await old.rootCa(), port: old.httpsPort, waitMs: 5000 });
	const after = await porch.check({
		ca: await fresh.rootCa(),
		port: fresh.httpsPort,
		waitMs: 5000,
	});
	expect(before).toEqual([
		{ name: "docs", status: 200 },
		{ name: "gone", status: 502 },
		{ name: "tv", status: 200 },
	]);
	expect(after).toEqual(before);
	// The same config read from the running Caddy's admin API maps the same way.
	expect(importCaddyConfig(await readCaddyConfig(old.admin), config).porches).toEqual(porches);
});
