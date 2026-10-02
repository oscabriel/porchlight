// Reads a running Caddy's config from its admin API, for `porch import`.
// Porch never writes through the admin API: the user's Caddy is theirs.
import { PorchError } from "./errors.ts";

const UNIX = "unix/";

/**
 * Where a Caddy's admin API listens: an `http://host:port` URL, or a Unix
 * socket in Caddy's own `unix//path` form.
 */
export const adminAddress = (admin: string) => {
	if (admin.startsWith(UNIX)) {
		const socket = admin.slice(UNIX.length);
		return {
			shown: socket,
			// Caddy's admin API refuses requests without a Host header.
			url: (route: string) => `http://localhost${route}`,
			via: { unix: socket },
		};
	}
	const base = new URL(admin);
	return { shown: base.host, url: (route: string) => new URL(route, base).href, via: {} };
};

/** True for the two forms `adminAddress` understands. */
export const isAdminAddress = (text: string) => /^(?:https?:\/\/|unix\/)/u.test(text);

/** A running Caddy's whole config, as `GET /config/` reports it (`null` when empty). */
export const liveCaddyConfig = async (admin: string): Promise<unknown> => {
	const address = adminAddress(admin);
	let res: Response;
	try {
		res = await fetch(address.url("/config/"), { ...address.via });
	} catch (error) {
		throw new PorchError(
			"caddy-unreachable",
			`Can't reach Caddy's admin API at ${address.shown} (${(error as Error).message}). Is Caddy running?`,
		);
	}
	if (!res.ok) {
		throw new PorchError(
			"caddy-unreachable",
			`Caddy at ${address.shown} returned ${res.status} for GET /config/`,
		);
	}
	return res.json();
};
