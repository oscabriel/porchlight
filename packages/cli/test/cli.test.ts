import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MachineConfig } from "../src/schema.ts";
import { startCaddy } from "./support/caddy.ts";
import type { TestCaddy } from "./support/caddy.ts";

const cli = path.join(import.meta.dir, "..", "src", "cli.ts");

let caddy: TestCaddy;
let home: string;
const servers: { stop: (force?: boolean) => unknown }[] = [];

beforeAll(async () => {
	caddy = await startCaddy();
});
afterAll(async () => {
	await caddy.stop();
});
beforeEach(async () => {
	home = await mkdtemp(path.join(tmpdir(), "porch-cli-"));
	const config: MachineConfig = {
		acmeEmail: "admin@porch.test",
		artifacts: path.join(home, "artifacts"),
		caddy: { admin: caddy.admin, listen: [`127.0.0.1:${caddy.httpsPort}`], managed: false },
		dns: { provider: "cloudflare", tokenEnv: "UNUSED" },
		domain: "porch.test",
		network: "tailscale",
		ports: { range: [3001, 3999] },
		tls: { issuer: "internal" },
	};
	await mkdir(path.join(home, "config", "porchlight"), { recursive: true });
	await Bun.write(path.join(home, "config", "porchlight", "config.json"), JSON.stringify(config));
});
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
	await rm(home, { force: true, recursive: true });
});

const porch = async (...args: string[]) => {
	const proc = Bun.spawn(["bun", cli, ...args], {
		env: {
			HOME: home,
			PATH: process.env.PATH ?? "",
			XDG_CONFIG_HOME: path.join(home, "config"),
			XDG_STATE_HOME: path.join(home, "state"),
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stderr, stdout };
};

const upstream = (body: string) => {
	const server = Bun.serve({ fetch: () => new Response(body), hostname: "127.0.0.1", port: 0 });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
};

test("add prints the porch's URL, and ls --json shows it lit", async () => {
	const added = await porch("add", "tv", upstream("tv"));
	expect(added).toEqual({ code: 0, stderr: "", stdout: "https://tv.porch.test\n" });

	const ls = await porch("ls", "--json");
	expect(ls.code).toBe(0);
	expect(JSON.parse(ls.stdout)).toEqual([
		{ kind: "service", name: "tv", state: "lit", url: "https://tv.porch.test" },
	]);
	expect((await caddy.get("tv.porch.test")).body).toBe("tv");
});

test("a refusal exits 1 with the reason on stderr, or as JSON with --json", async () => {
	const plain = await porch("add", "my.app", "http://127.0.0.1:9");
	expect(plain.code).toBe(1);
	expect(plain.stdout).toBe("");
	expect(plain.stderr).toContain('porch: "my.app" is not a valid porch name');

	const json = await porch("rm", "ghost", "--json");
	expect(json.code).toBe(1);
	expect(JSON.parse(json.stdout)).toEqual({
		error: { code: "missing", message: "ghost is not a porch. Run `porch ls` to see them." },
	});
});

test("add and serve refuse reserved names", async () => {
	const added = await porch("add", "www", "http://127.0.0.1:9", "--label", "Web");
	expect(added.code).toBe(1);
	expect(added.stderr).toContain("www is reserved");

	const served = await porch("serve", "api", home, "--no-cache");
	expect(served.code).toBe(1);
	expect(served.stderr).toContain("api is reserved");
});

test("a missing machine config says to run porch init", async () => {
	await rm(path.join(home, "config"), { force: true, recursive: true });

	const res = await porch("ls");

	expect(res.code).toBe(1);
	expect(res.stderr).toContain("porch init");
});

test("an unknown command or missing argument exits 2 with usage", async () => {
	expect((await porch("frobnicate")).code).toBe(2);
	const missing = await porch("add", "tv");
	expect(missing.code).toBe(2);
	expect(missing.stderr).toContain("porch add <name> <upstream>");
});
