// Client for Caddy's admin API. Config replacement goes through
// `POST /config/` with If-Match: `POST /load` ignores If-Match.

import { PorchError } from "./errors.ts";

export const createCaddyAdmin = (admin: string) => {
	const base = admin.replace(/\/+$/u, "");

	/** Caddy's whole config (`null` when empty) and the ETag to replace it with. */
	const current = async () => {
		const res = await fetch(`${base}/config/`);
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
		const res = await fetch(`${base}/config/`, {
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
