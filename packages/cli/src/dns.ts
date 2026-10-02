// Public DNS over HTTPS. Plain port-53 lookups get intercepted on many home
// networks (routers, Pi-hole), which makes "does the record exist yet" lie.
const DOH = "https://cloudflare-dns.com/dns-query";

/** The A records for `name` as the public internet sees them. */
export const resolvePublic = async (name: string): Promise<string[]> => {
	const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=A`, {
		headers: { accept: "application/dns-json" },
		signal: AbortSignal.timeout(5000),
	});
	const body = (await res.json()) as { Answer?: { data: string; type: number }[] };
	return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
};
