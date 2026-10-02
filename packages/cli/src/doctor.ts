// `porch doctor`: checks everything porch depends on and changes nothing.
// Each check reports ok or not with one line of detail.
import { Resolver, resolve4 } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { connect } from "node:tls";
import { importLines } from "./caddyfile.ts";
import { expandHome } from "./paths.ts";
import { openPorchlight } from "./porchlight.ts";
import { readSnippet, snippetDir } from "./proxy.ts";
import type { MachineConfig } from "./schema.ts";

export interface Check {
	detail: string;
	name: string;
	ok: boolean;
}

const HTTPS_PORT = 443;

const PRIVATE = [
	[10, 0, 8],
	[172, 16, 12],
	[192, 168, 16],
	// CGNAT, which Tailscale uses
	[100, 64, 10],
	[127, 0, 8],
] as const;

const toInt = (ip: string) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);

export const isPrivate = (ip: string) =>
	PRIVATE.some(([a, b, bits]) => {
		const base = toInt(`${a}.${b}.0.0`);
		const mask = 2 ** 32 - 2 ** (32 - bits);
		// eslint-disable-next-line no-bitwise -- CIDR match
		return (toInt(ip) & mask) >>> 0 === (base & mask) >>> 0;
	});

/** This machine's IPv4 addresses. */
export const localAddresses = () =>
	new Set(
		Object.values(networkInterfaces())
			.flat()
			.flatMap((i) => (i?.family === "IPv4" ? [i.address] : [])),
	);

/** Stdout of a command, or null when it fails or isn't installed. */
const sh = async (cmd: string[]): Promise<string | null> => {
	try {
		const proc = Bun.spawn(cmd, { stderr: "ignore", stdout: "pipe" });
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? stdout : null;
	} catch {
		return null;
	}
};

/** Lines a Caddyfile has to contain to import the snippet. The fallback is optional. */
const requiredImports = (config: MachineConfig) => importLines(snippetDir(config)).slice(0, 2);

const snippetChecks = async (config: MachineConfig, stateDir: string): Promise<Check[]> => {
	const porch = openPorchlight({ config, stateDir });
	const [rendered, onDisk] = await Promise.all([porch.render(), readSnippet(config)]);
	const stale = Object.entries(rendered).filter(([file, text]) => onDisk[file as never] !== text);
	const checks: Check[] = [
		{
			detail:
				stale.length === 0
					? `${snippetDir(config)} matches the registry`
					: `${stale.map(([file]) => file).join(", ")} in ${snippetDir(config)} differ from the registry. Run \`porch apply\``,
			name: "Snippet is current",
			ok: stale.length === 0,
		},
	];
	const caddyfile = config.proxy.config;
	if (caddyfile) {
		const text = await Bun.file(expandHome(caddyfile))
			.text()
			.catch(() => null);
		const missing = requiredImports(config).filter((l) => !text?.includes(l));
		const detail = (() => {
			if (text === null) {
				return `can't read ${caddyfile}`;
			}
			if (missing.length === 0) {
				return `${caddyfile} imports it`;
			}
			return `${caddyfile} is missing: ${missing.join("  ")}. Add them inside its *.${config.domain} block`;
		})();
		checks.push({
			detail,
			name: "Caddyfile imports the snippet",
			ok: text !== null && missing.length === 0,
		});
	}
	return checks;
};

/** Every porch fetched through the proxy on :443. A dark porch's 502 still counts: the proxy answered for it. */
const servedChecks = async (config: MachineConfig, stateDir: string): Promise<Check[]> => {
	const porch = openPorchlight({ config, stateDir });
	const served = await porch.check({ port: HTTPS_PORT });
	if (served.length === 0) {
		return [];
	}
	const failed = served.filter((s) => "error" in s);
	return [
		{
			detail:
				failed.length === 0
					? `all ${served.length} answer with a valid certificate`
					: `${failed.length} of ${served.length} don't: ${failed
							.map((f) => `${f.name} (${"error" in f ? f.error : ""})`)
							.join(", ")}`,
			name: `Every porch answers through the proxy on :${HTTPS_PORT}`,
			ok: failed.length === 0,
		},
	];
};

// Linux SO_REUSEPORT lets two Caddys both bind :443, and the kernel then
// splits connections between them. Nothing else reports it.
const port443Check = async (): Promise<Check[]> => {
	const ss = await sh(["ss", "-ltnpH", `sport = :${HTTPS_PORT}`]);
	if (ss === null) {
		return [];
	}
	const owners = new Set([...ss.matchAll(/pid=(?<pid>\d+)/gu)].map((m) => m.groups?.pid));
	const listeners = ss.trim() ? ss.trim().split("\n").length : 0;
	const count = owners.size || listeners;
	return [
		{
			detail:
				count === 1 ? "one listener" : `${count} listeners. Connections are split between them`,
			name: `Only one process holds :${HTTPS_PORT}`,
			ok: count === 1,
		},
	];
};

const dnsChecks = async (config: MachineConfig): Promise<Check[]> => {
	const probe = `porch-doctor-${crypto.randomUUID().slice(0, 8)}.${config.domain}`;
	let addresses: string[];
	try {
		addresses = await resolve4(probe);
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		const publicDns = new Resolver({ timeout: 3000, tries: 1 });
		publicDns.setServers(["1.1.1.1"]);
		const elsewhere = await publicDns.resolve4(probe).catch(() => []);
		// Many routers drop public answers that point at private addresses
		// ("DNS rebinding protection"), and the lookup then fails only here.
		const rebinding =
			elsewhere.length > 0
				? `. 1.1.1.1 answers ${elsewhere.join(", ")}, so the resolver this machine uses is dropping it. Usually that's a router's DNS rebinding protection: allow ${config.domain} in its settings, or use Tailscale's DNS`
				: "";
		return [
			{
				detail: `${probe} didn't resolve: ${code}${rebinding}`,
				name: `*.${config.domain} resolves`,
				ok: false,
			},
		];
	}
	const mine = localAddresses();
	const here = addresses.filter((a) => mine.has(a));
	const publicOnes = addresses.filter((a) => !isPrivate(a));
	return [
		{ detail: addresses.join(", "), name: `*.${config.domain} resolves`, ok: true },
		{
			detail:
				here.length > 0
					? `${here.join(", ")} is this machine`
					: `none of ${addresses.join(", ")} is this machine`,
			name: "DNS points at this machine",
			ok: here.length > 0,
		},
		{
			detail:
				publicOnes.length === 0
					? "private addresses only, so the porches stay off the public internet"
					: `${publicOnes.join(", ")} is public`,
			name: "DNS points at a private address",
			ok: publicOnes.length === 0,
		},
	];
};

const certCheck = (config: MachineConfig): Promise<Check[]> => {
	const host = "127.0.0.1";
	const port = HTTPS_PORT;
	const name = `Certificate covers *.${config.domain}`;
	const { promise, resolve: done } = Promise.withResolvers<Check[]>();
	{
		const socket = connect(
			{
				host,
				port,
				rejectUnauthorized: false,
				servername: `porch-doctor.${config.domain}`,
				timeout: 3000,
			},
			() => {
				const cert = socket.getPeerCertificate();
				socket.end();
				const covers = (cert.subjectaltname ?? "").split(", ").includes(`DNS:*.${config.domain}`);
				const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
				done([
					{
						detail: covers
							? `issued by ${cert.issuer?.O ?? cert.issuer?.CN}, ${days} days left`
							: `the cert covers ${cert.subjectaltname || "nothing"}`,
						name,
						ok: covers && days > 7,
					},
				]);
			},
		);
		socket.on("error", (error) =>
			done([{ detail: `no TLS on ${host}:${port}: ${error.message}`, name, ok: false }]),
		);
		socket.on("timeout", () => {
			socket.destroy();
			done([{ detail: `no TLS answer on ${host}:${port}`, name, ok: false }]);
		});
	}
	return promise;
};

export const doctor = async (config: MachineConfig, stateDir: string): Promise<Check[]> => {
	const groups = await Promise.all([
		snippetChecks(config, stateDir),
		port443Check(),
		dnsChecks(config),
		certCheck(config),
		servedChecks(config, stateDir),
	]);
	return groups.flat();
};
