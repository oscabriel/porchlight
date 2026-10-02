// A throwaway Caddy for tests, run the way a user runs theirs: from a
// Caddyfile that imports porch's snippet. It listens on random loopback
// ports, and HOME and XDG dirs point at a temp dir. Never the machine's real
// Caddy: see AGENTS.md.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CADDY_VERSION = "2.11.6";
const repoRoot = path.resolve(import.meta.dir, "../../../..");
const cacheDir = path.join(repoRoot, ".cache", `caddy-${CADDY_VERSION}`);
const binary = path.join(cacheDir, "caddy");

const platform = () => {
	const os = { darwin: "mac", linux: "linux" }[process.platform as string];
	const arch = { arm64: "arm64", x64: "amd64" }[process.arch as string];
	if (!(os && arch)) {
		throw new Error(`no test Caddy for ${process.platform}/${process.arch}`);
	}
	return `${os}_${arch}`;
};

const run = async (cmd: string[], cwd?: string) => {
	const proc = Bun.spawn(cmd, { stderr: "pipe", stdout: "pipe", ...(cwd && { cwd }) });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`${cmd.join(" ")} exited ${code}: ${err}`);
	}
	return out;
};

/** Downloads stock Caddy into `.cache/` once, checking the release checksum. */
export const ensureCaddy = async () => {
	if (await Bun.file(binary).exists()) {
		return binary;
	}
	await mkdir(cacheDir, { recursive: true });
	const base = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}`;
	const tarball = `caddy_${CADDY_VERSION}_${platform()}.tar.gz`;
	const [archive, sums] = await Promise.all([
		fetch(`${base}/${tarball}`).then((r) => r.arrayBuffer()),
		fetch(`${base}/caddy_${CADDY_VERSION}_checksums.txt`).then((r) => r.text()),
	]);
	const expected = sums
		.split("\n")
		.find((line) => line.endsWith(` ${tarball}`))
		?.split(" ")[0];
	const actual = new Bun.CryptoHasher("sha512").update(archive).digest("hex");
	if (!expected || expected !== actual) {
		throw new Error(`checksum mismatch for ${tarball}`);
	}
	const archivePath = path.join(cacheDir, tarball);
	await Bun.write(archivePath, archive);
	await run(["tar", "-xzf", archivePath, "caddy"], cacheDir);
	await rm(archivePath);
	return binary;
};

/** Puts the test Caddy on PATH for code that shells out to `caddy`, such as `caddy adapt`. */
export const withCaddyOnPath = async () => {
	await ensureCaddy();
	if (!process.env.PATH?.split(":").includes(cacheDir)) {
		process.env.PATH = `${cacheDir}:${process.env.PATH ?? ""}`;
	}
};

export const freePort = () => {
	const server = Bun.serve({ fetch: () => new Response(), hostname: "127.0.0.1", port: 0 });
	const { port } = server;
	server.stop(true);
	if (port === undefined) {
		throw new Error("no free port");
	}
	return port;
};

export type TestCaddy = Awaited<ReturnType<typeof startCaddy>>;

const EMPTY_SNIPPET = "# empty until porch writes it\n";

/**
 * Starts a Caddy from a Caddyfile shaped like a user's: one `*.porch.test`
 * site with its own TLS, `site` lines of its own (hand-written handles), and
 * the three snippet imports. `reload` is the command porch runs after a change.
 */
export const startCaddy = async ({ site = "" } = {}) => {
	const bin = await ensureCaddy();
	const home = await mkdtemp(path.join(tmpdir(), "porch-caddy-"));
	const httpsPort = freePort();
	const adminPort = freePort();
	const admin = `http://127.0.0.1:${adminPort}`;
	const snippetDir = path.join(home, "porchlight");
	await mkdir(snippetDir);
	await Promise.all(
		["porches.caddy", "errors.caddy", "fallback.caddy"].map((file) =>
			Bun.write(path.join(snippetDir, file), EMPTY_SNIPPET),
		),
	);
	const caddyfile = path.join(home, "Caddyfile");

	/** Rewrites the Caddyfile. `extra` goes into the site block, for breaking it on purpose. */
	const writeCaddyfile = (extra = "") =>
		Bun.write(
			caddyfile,
			`{
	admin 127.0.0.1:${adminPort}
	local_certs
	skip_install_trust
	auto_https disable_redirects
}

*.porch.test:${httpsPort} {
	tls internal
	encode zstd gzip
${site}${extra}
	import ${snippetDir}/porches.caddy
	import ${snippetDir}/errors.caddy
	import ${snippetDir}/fallback.caddy
}
`,
		);
	await writeCaddyfile();

	const env = {
		HOME: home,
		PATH: process.env.PATH ?? "",
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_DATA_HOME: path.join(home, "data"),
	};
	const proc = Bun.spawn([bin, "run", "--config", caddyfile], {
		env,
		stderr: "pipe",
		stdout: "pipe",
	});

	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			// eslint-disable-next-line no-await-in-loop -- polling until Caddy is up
			if ((await fetch(`${admin}/config/`)).ok) {
				break;
			}
		} catch {
			if (Date.now() > deadline) {
				proc.kill();
				throw new Error("throwaway Caddy did not start");
			}
			// eslint-disable-next-line no-await-in-loop -- polling until Caddy is up
			await Bun.sleep(50);
		}
	}

	/**
	 * GET https://<host>:<httpsPort><path> through Caddy, with SNI and Host set.
	 * Uses curl so TLS works like a browser's. Retries TLS handshake failures
	 * (curl exit 35) for a few seconds, because Caddy issues certs after a load returns.
	 */
	const get = async (host: string, urlPath = "/", requestHeaders: string[] = []) => {
		const cmd = [
			"curl",
			"-sk",
			"--max-time",
			"5",
			"--resolve",
			`${host}:${httpsPort}:127.0.0.1`,
			...requestHeaders.flatMap((h) => ["-H", h]),
			"-o",
			"-",
			"-w",
			"\n%{http_code}",
			`https://${host}:${httpsPort}${urlPath}`,
		];
		const until = Date.now() + 5000;
		for (;;) {
			const curl = Bun.spawn(cmd, { stderr: "pipe", stdout: "pipe" });
			// eslint-disable-next-line no-await-in-loop -- retrying until the cert exists
			const [out, code] = await Promise.all([new Response(curl.stdout).text(), curl.exited]);
			if (code === 0) {
				const cut = out.lastIndexOf("\n");
				return { body: out.slice(0, cut), status: Number(out.slice(cut + 1)) };
			}
			if (code !== 35 || Date.now() > until) {
				throw new Error(`curl ${host}${urlPath} exited ${code}`);
			}
			// eslint-disable-next-line no-await-in-loop -- retrying until the cert exists
			await Bun.sleep(100);
		}
	};

	/** Response headers (lowercased names, first value) for a GET through Caddy. */
	const headers = async (host: string, urlPath = "/", requestHeaders: string[] = []) => {
		await get(host, urlPath, requestHeaders);
		const out = await run([
			"curl",
			"-sk",
			"--max-time",
			"5",
			"--resolve",
			`${host}:${httpsPort}:127.0.0.1`,
			...requestHeaders.flatMap((h) => ["-H", h]),
			"-o",
			"/dev/null",
			"-w",
			"%{header_json}",
			`https://${host}:${httpsPort}${urlPath}`,
		]);
		const parsed = JSON.parse(out) as Record<string, string[]>;
		return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v[0] ?? ""]));
	};

	const stop = async () => {
		proc.kill();
		await proc.exited;
		await rm(home, { force: true, recursive: true });
	};

	/** The root certificate of this Caddy's internal CA, to verify its certs against. */
	const rootCa = async () => {
		const res = await fetch(`${admin}/pki/ca/local`);
		return ((await res.json()) as { root_certificate: string }).root_certificate;
	};

	return {
		admin,
		caddyfile,
		get,
		headers,
		httpsPort,
		reload: `${bin} reload --config ${caddyfile} --adapter caddyfile`,
		rootCa,
		snippetDir,
		stop,
		writeCaddyfile,
	};
};
