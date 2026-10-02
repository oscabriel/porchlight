// Client for Caddy's admin API. Config replacement goes through
// `POST /config/` with If-Match: `POST /load` ignores If-Match.

import { PorchError } from "./errors.ts";

const UNIX = "unix/";

/**
 * Where Caddy's admin API listens, from the machine config's `caddy.admin`:
 * an `http://host:port` URL, or a Unix socket in Caddy's own `unix//path`
 * form. `listen` is the value for Caddy's `admin.listen`. A socket gets mode
 * 0600, so only the user Caddy runs as can open it.
 */
export const adminAddress = (admin: string) => {
	if (admin.startsWith(UNIX)) {
		const socket = admin.slice(UNIX.length);
		return {
			listen: `${UNIX}${socket}|0600`,
			local: true,
			shown: socket,
			// Caddy's admin API refuses requests without a Host header.
			url: (route: string) => `http://localhost${route}`,
			via: { unix: socket },
		};
	}
	const base = new URL(admin);
	return {
		listen: base.host,
		local: ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname),
		shown: base.host,
		url: (route: string) => new URL(route, base).href,
		via: {},
	};
};

/** `fetch` against Caddy's admin API, wherever it listens. */
export const adminFetch = (admin: string, route: string, init: RequestInit = {}) => {
	const address = adminAddress(admin);
	return fetch(address.url(route), { ...init, ...address.via });
};

export const createCaddyAdmin = (admin: string) => {
	const base = adminAddress(admin).shown;

	const call = async (init?: RequestInit) => {
		try {
			return await adminFetch(admin, "/config/", init);
		} catch (error) {
			throw new PorchError(
				"caddy-unreachable",
				`Can't reach Caddy's admin API at ${base} (${(error as Error).message}). Is Caddy running?`,
			);
		}
	};

	/** Caddy's whole config (`null` when empty) and the ETag to replace it with. */
	const current = async () => {
		const res = await call();
		if (!res.ok) {
			throw new PorchError(
				"caddy-unreachable",
				`Caddy at ${base} returned ${res.status} for GET /config/`,
			);
		}
		return { config: (await res.json()) as unknown, etag: res.headers.get("etag") ?? "" };
	};

	/** Replaces the whole config, failing if someone else changed it since `expected`. */
	const replace = async (config: unknown, expected: string) => {
		const res = await call({
			body: JSON.stringify(config),
			headers: { "Content-Type": "application/json", "If-Match": expected },
			method: "POST",
		});
		if (res.status === 412) {
			throw new PorchError(
				"caddy-conflict",
				"Caddy's config changed while porch was applying. Run the command again.",
			);
		}
		if (!res.ok) {
			const body = await res.text();
			let message = body;
			try {
				message = (JSON.parse(body) as { error?: string }).error ?? body;
			} catch {
				// not JSON, keep the raw body
			}
			throw new PorchError("caddy-rejected", `Caddy rejected the config: ${message}`);
		}
	};

	return { current, replace };
};
