// A fake of the slice of Cloudflare's v4 API that porch uses: find a zone by
// name, list a zone's DNS records by exact name, create one. Response shapes
// match the real API (checked against it on 2026-10-01).

export interface FakeRecord {
	content: string;
	name: string;
	proxied: boolean;
	type: string;
}

interface FakeOptions {
	/** Zones the token can see, by name. */
	zones?: string[];
	/** False when the token can read DNS but not edit it. */
	canEdit?: boolean;
	records?: FakeRecord[];
}

const zoneId = (name: string) => `zone-${name}`;

export const TOKEN = "fake-token-0123456789abcdef0123456789abcdef";

const envelope = (result: unknown, status = 200) =>
	Response.json({ errors: [], messages: [], result, success: true }, { status });

const failure = (status: number, code: number, message: string) =>
	Response.json(
		{ errors: [{ code, message }], messages: [], result: null, success: false },
		{ status },
	);

export const startFakeCloudflare = ({
	zones = ["porch.test"],
	canEdit = true,
	records = [],
}: FakeOptions = {}) => {
	const writes: FakeRecord[] = [];

	const server = Bun.serve({
		fetch: async (req) => {
			if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
				return failure(403, 9109, "Invalid access token");
			}
			const url = new URL(req.url);
			if (url.pathname === "/client/v4/zones" && req.method === "GET") {
				const name = url.searchParams.get("name");
				return envelope(zones.filter((z) => z === name).map((z) => ({ id: zoneId(z), name: z })));
			}
			const match = url.pathname.match(/^\/client\/v4\/zones\/(?<id>[^/]+)\/dns_records$/u);
			const zone = zones.find((z) => zoneId(z) === match?.groups?.id);
			if (!zone) {
				return failure(
					404,
					7003,
					"Could not route to /zones/..., perhaps your object identifier is invalid?",
				);
			}
			if (req.method === "GET") {
				const name = url.searchParams.get("name.exact");
				return envelope(records.filter((r) => r.name === name));
			}
			if (req.method === "POST") {
				if (!canEdit) {
					return failure(403, 10_000, "Authentication error");
				}
				const record = (await req.json()) as FakeRecord;
				records.push(record);
				writes.push(record);
				return envelope(record);
			}
			return failure(405, 10_000, "method not allowed");
		},
		hostname: "127.0.0.1",
		port: 0,
	});

	return {
		api: `http://127.0.0.1:${server.port}/client/v4`,
		records,
		stop: () => server.stop(true),
		writes,
	};
};
