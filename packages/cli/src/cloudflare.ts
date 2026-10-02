// The wildcard DNS record `porch init` keeps on Cloudflare: `*.<domain>`, an
// A record pointing at this machine's private address, never proxied.
import { PorchError } from "./errors.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
	errors: { code: number; message: string }[];
	result: T;
	success: boolean;
}

interface DnsRecord {
	content: string;
	name: string;
	proxied: boolean;
	type: string;
}

export interface WildcardRecordOptions {
	/** The v4 API base. Tests point it at a fake. */
	api?: string;
	domain: string;
	ip: string;
	token: string;
}

export const ensureWildcardRecord = async ({
	api = CLOUDFLARE_API,
	domain,
	ip,
	token,
}: WildcardRecordOptions) => {
	const name = `*.${domain}`;
	const fix = `The Cloudflare token needs Zone → Zone → Read and Zone → DNS → Edit on ${domain}. Make one at https://dash.cloudflare.com/profile/api-tokens.`;
	const call = async <T>(route: string, init: RequestInit = {}) => {
		const res = await fetch(`${api}${route}`, {
			...init,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		});
		const body = (await res.json()) as Envelope<T>;
		if (!body.success) {
			const reason = body.errors.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
			throw new PorchError("dns-denied", `Cloudflare refused: ${reason}. ${fix}`);
		}
		return body.result;
	};

	const [zone] = await call<{ id: string }[]>(`/zones?name=${encodeURIComponent(domain)}`);
	if (!zone) {
		throw new PorchError("dns-denied", `Cloudflare token can't see ${domain}. ${fix}`);
	}
	const existing = await call<DnsRecord[]>(
		`/zones/${zone.id}/dns_records?name.exact=${encodeURIComponent(name)}`,
	);
	if (existing.some((r) => r.type === "A" && r.content === ip && !r.proxied)) {
		return { action: "kept" as const, ip, name };
	}
	const [other] = existing;
	if (other) {
		const proxied = other.proxied ? ", proxied through Cloudflare" : "";
		throw new PorchError(
			"dns-conflict",
			`${name} is already set (${other.type} ${other.content}${proxied}). Porch won't change a record it didn't make. In Cloudflare, point it at ${ip} as an unproxied A record, or delete it, then run \`porch init\` again.`,
		);
	}
	await call(`/zones/${zone.id}/dns_records`, {
		body: JSON.stringify({ content: ip, name, proxied: false, ttl: 1, type: "A" }),
		method: "POST",
	});
	return { action: "created" as const, ip, name };
};
