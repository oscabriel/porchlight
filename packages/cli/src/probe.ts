// Lit or dark: does a porch's upstream answer? Checks the upstream itself,
// not the URL through Caddy, so it says which side is broken.
import { stat } from "node:fs/promises";
import { expandHome } from "./paths.ts";
import type { MachineConfig, Porch } from "./schema.ts";

export type PorchState = "dark" | "lit";

const TIMEOUT_MS = 1500;

/** Any HTTP response counts as lit, even a 500: something is answering. */
const answers = async (url: string) => {
	try {
		await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			tls: { rejectUnauthorized: false },
		});
		return true;
	} catch {
		return false;
	}
};

const isDir = async (dir: string) => {
	try {
		const info = await stat(expandHome(dir));
		return info.isDirectory();
	} catch {
		return false;
	}
};

/** The address a porch forwards to, for messages and probes. */
export const upstreamOf = (config: MachineConfig, porch: Porch) => {
	switch (porch.kind) {
		case "artifacts": {
			return config.artifacts;
		}
		case "dev": {
			return `http://127.0.0.1:${porch.port}`;
		}
		case "service": {
			return porch.upstream;
		}
		case "static": {
			return porch.root;
		}
		default: {
			throw new Error("unknown porch kind");
		}
	}
};

export const probe = async (config: MachineConfig, porch: Porch): Promise<PorchState> => {
	const target = upstreamOf(config, porch);
	const ok =
		porch.kind === "static" || porch.kind === "artifacts"
			? await isDir(target)
			: await answers(target);
	return ok ? "lit" : "dark";
};

export type Served = { status: number } | { error: string };

/**
 * GETs `https://<host>/` from this machine's Caddy on `port`, verifying its
 * certificate for `host` (against `ca` when given, else the system's roots).
 * Retries failures for `waitMs`, since Caddy gets certificates after a load.
 */
export const throughCaddy = async (
	host: string,
	port: number,
	{ ca, waitMs = 0 }: { ca?: string; waitMs?: number } = {},
): Promise<Served> => {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			// eslint-disable-next-line no-await-in-loop -- retrying until the deadline
			const res = await fetch(`https://127.0.0.1:${port}/`, {
				headers: { Host: host },
				redirect: "manual",
				signal: AbortSignal.timeout(TIMEOUT_MS),
				tls: { serverName: host, ...(ca && { ca }) },
			});
			// eslint-disable-next-line no-await-in-loop -- free the connection
			await res.body?.cancel();
			return { status: res.status };
		} catch (error) {
			if (Date.now() >= deadline) {
				return { error: (error as Error).message };
			}
			// eslint-disable-next-line no-await-in-loop -- retrying until the deadline
			await Bun.sleep(100);
		}
	}
};
