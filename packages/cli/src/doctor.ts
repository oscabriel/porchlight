// `porch doctor`: checks everything porch depends on and changes nothing.
// Each check reports ok or not with one line of detail.
import { Resolver, resolve4 } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { connect } from "node:tls";
import { adminAddress, adminFetch } from "./caddy-admin.ts";
import { installedCaddyVersion, isOlder, latestCaddyVersion } from "./caddy-install.ts";
import { managedCaddyFiles } from "./machine.ts";
import type { MachineConfig } from "./schema.ts";

export interface Check {
	detail: string;
	name: string;
	ok: boolean;
}

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

const localAddresses = () =>
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

const caddyChecks = async (config: MachineConfig): Promise<Check[]> => {
	const admin = adminAddress(config.caddy.admin);
	const checks: Check[] = [
		{
			detail: admin.local
				? `${admin.shown} answers only this machine`
				: `${admin.shown} may be reachable from other machines, and the admin API has no auth`,
			name: "Caddy admin is local-only",
			ok: admin.local,
		},
	];
	try {
		const res = await adminFetch(config.caddy.admin, "/config/", {
			signal: AbortSignal.timeout(2000),
		});
		const body = (await res.json()) as {
			apps?: { http?: { servers?: Record<string, unknown> } };
		} | null;
		checks.push({
			detail: `${admin.shown} returned ${res.status}`,
			name: "Caddy admin API answers",
			ok: res.ok,
		});
		const ours = body?.apps?.http?.servers?.porchlight !== undefined;
		checks.push({
			detail: ours
				? "the live config is porch's"
				: "Caddy is running a config porch didn't render. `porch apply` replaces it (and `porch rollback` puts it back)",
			name: "Caddy runs porch's config",
			ok: ours,
		});
	} catch (error) {
		checks.push({
			detail: `can't reach ${admin.shown}: ${(error as Error).message}`,
			name: "Caddy admin API answers",
			ok: false,
		});
	}
	return checks;
};

// Linux SO_REUSEPORT lets two Caddys both bind :443, and the kernel then
// splits connections between them. Nothing else reports it.
const port443Check = async (): Promise<Check[]> => {
	const ss = await sh(["ss", "-ltnpH", "sport = :443"]);
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
			name: "Only one process holds :443",
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
	const listen = config.caddy.listen?.[0] ?? ":443";
	const cut = listen.lastIndexOf(":");
	const host = listen.slice(0, cut) || "127.0.0.1";
	const port = Number(listen.slice(cut + 1));
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

const caddyVersionCheck = async (config: MachineConfig): Promise<Check[]> => {
	if (!config.caddy.managed) {
		return [];
	}
	const [installed, latest] = await Promise.all([
		installedCaddyVersion(managedCaddyFiles().binary),
		latestCaddyVersion(),
	]);
	if (!installed) {
		return [
			{
				detail: `no Caddy at ${managedCaddyFiles().binary}. Run \`porch init\``,
				name: "Caddy is up to date",
				ok: false,
			},
		];
	}
	if (!latest) {
		return [];
	}
	const behind = isOlder(installed, latest);
	return [
		{
			detail: behind
				? `${installed} installed, ${latest} is out. Run \`porch init\` again to upgrade`
				: `${installed}`,
			name: "Caddy is up to date",
			ok: !behind,
		},
	];
};

const networkCheck = async (config: MachineConfig): Promise<Check[]> => {
	if (config.network !== "tailscale") {
		return [];
	}
	const status = await sh(["tailscale", "status", "--json"]);
	const state = status
		? ((JSON.parse(status) as { BackendState?: string }).BackendState ?? "unknown")
		: "not installed";
	return [{ detail: `backend state ${state}`, name: "Tailscale is up", ok: state === "Running" }];
};

export const doctor = async (config: MachineConfig): Promise<Check[]> => {
	const groups = await Promise.all([
		caddyChecks(config),
		port443Check(),
		dnsChecks(config),
		certCheck(config),
		caddyVersionCheck(config),
		networkCheck(config),
	]);
	return groups.flat();
};
