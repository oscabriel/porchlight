// The Caddy that `porch init` installs: a build with the DNS provider's module
// from caddyserver.com's download API, kept in porch's data dir. Re-running
// `init` replaces it when a newer Caddy is out.
import { chmod, rename, rm } from "node:fs/promises";
import { PorchError } from "./errors.ts";

const LATEST = "https://api.github.com/repos/caddyserver/caddy/releases/latest";
const DNS_MODULE = { cloudflare: "github.com/caddy-dns/cloudflare" } as const;

const run = async (cmd: string[]) => {
	try {
		const proc = Bun.spawn(cmd, { stderr: "pipe", stdout: "pipe" });
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? stdout : null;
	} catch {
		return null;
	}
};

/** `2.11.6` from `v2.11.6 h1:...`, or null when the binary is missing or isn't Caddy. */
export const installedCaddyVersion = async (binary: string) => {
	const out = await run([binary, "version"]);
	return out?.match(/^v(?<version>\d+\.\d+\.\d+)/u)?.groups?.version ?? null;
};

/** The newest stable Caddy release, or null when GitHub can't be reached. */
export const latestCaddyVersion = async () => {
	try {
		const res = await fetch(LATEST, {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(5000),
		});
		const { tag_name: tag } = (await res.json()) as { tag_name?: string };
		return tag?.replace(/^v/u, "") ?? null;
	} catch {
		return null;
	}
};

/** True when `a` is an older version than `b`. */
export const isOlder = (a: string, b: string) => {
	const [x, y] = [a, b].map((v) => v.split(".").map(Number));
	for (let i = 0; i < 3; i += 1) {
		const diff = (x?.[i] ?? 0) - (y?.[i] ?? 0);
		if (diff !== 0) {
			return diff < 0;
		}
	}
	return false;
};

const ARCH: Record<string, string> = { arm64: "arm64", x64: "amd64" };

/**
 * Downloads Caddy with the DNS provider's module to `binary`. The download API
 * publishes no checksums for custom builds, so this relies on HTTPS, then runs
 * the new binary to confirm it is Caddy with the module before swapping it in.
 * The rename is atomic, so a running Caddy keeps its old binary until restarted.
 */
export const downloadCaddy = async (binary: string, provider: keyof typeof DNS_MODULE) => {
	const arch = ARCH[process.arch];
	if (process.platform !== "linux" || !arch) {
		throw new PorchError(
			"unsupported",
			`porch init supports Linux on amd64 and arm64, not ${process.platform}/${process.arch}.`,
		);
	}
	const url = `https://caddyserver.com/api/download?os=linux&arch=${arch}&p=${encodeURIComponent(DNS_MODULE[provider])}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
	if (!res.ok) {
		throw new PorchError(
			"download-failed",
			`Downloading Caddy failed: ${url} returned ${res.status}`,
		);
	}
	const partial = `${binary}.download`;
	await Bun.write(partial, res);
	await chmod(partial, 0o755);
	const version = await installedCaddyVersion(partial);
	const modules = await run([partial, "list-modules"]);
	if (!(version && modules?.includes(`dns.providers.${provider}`))) {
		await rm(partial, { force: true });
		throw new PorchError(
			"download-failed",
			`What ${url} returned isn't Caddy with dns.providers.${provider}. Nothing was replaced.`,
		);
	}
	await rename(partial, binary);
	return version;
};
