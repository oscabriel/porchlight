import { afterEach, expect, test } from "bun:test";
import { ensureWildcardRecord } from "../src/cloudflare.ts";
import { startFakeCloudflare, TOKEN } from "./support/cloudflare.ts";

const fakes: { stop: () => unknown }[] = [];
const fake = (...args: Parameters<typeof startFakeCloudflare>) => {
	const cf = startFakeCloudflare(...args);
	fakes.push(cf);
	return cf;
};
afterEach(() => {
	for (const cf of fakes.splice(0)) {
		cf.stop();
	}
});

test("creates the wildcard record pointing at this machine when there isn't one", async () => {
	const cf = fake();

	const result = await ensureWildcardRecord({
		api: cf.api,
		domain: "porch.test",
		ip: "100.64.0.7",
		token: TOKEN,
	});

	expect(result).toEqual({ action: "created", ip: "100.64.0.7", name: "*.porch.test" });
	expect(cf.records).toEqual([
		expect.objectContaining({
			content: "100.64.0.7",
			name: "*.porch.test",
			proxied: false,
			type: "A",
		}),
	]);
});

test("leaves an existing wildcard record alone when it already points here", async () => {
	const cf = fake({
		records: [{ content: "100.64.0.7", name: "*.porch.test", proxied: false, type: "A" }],
	});

	const result = await ensureWildcardRecord({
		api: cf.api,
		domain: "porch.test",
		ip: "100.64.0.7",
		token: TOKEN,
	});

	expect(result).toEqual({ action: "kept", ip: "100.64.0.7", name: "*.porch.test" });
	expect(cf.writes).toEqual([]);
});

test("refuses to touch a wildcard record that points somewhere else, and says what's there", async () => {
	const elsewhere = [
		{ content: "100.64.0.99", name: "*.porch.test", proxied: false, type: "A" },
		{ content: "100.64.0.7", name: "*.porch.test", proxied: true, type: "A" },
		{ content: "other.example", name: "*.porch.test", proxied: false, type: "CNAME" },
	];
	for (const record of elsewhere) {
		const cf = fake({ records: [record] });

		// eslint-disable-next-line no-await-in-loop -- each record is its own case
		await expect(
			ensureWildcardRecord({ api: cf.api, domain: "porch.test", ip: "100.64.0.7", token: TOKEN }),
		).rejects.toThrow(`*.porch.test is already set (${record.type} ${record.content}`);
		expect(cf.writes).toEqual([]);
	}
});

test("a token that can't edit the zone's DNS gets one fix: which permission it needs", async () => {
	const cases = [
		{ cf: fake({ zones: ["elsewhere.test"] }), token: TOKEN },
		{ cf: fake({ canEdit: false }), token: TOKEN },
		{ cf: fake(), token: "wrong-token" },
	];
	for (const { cf, token } of cases) {
		// eslint-disable-next-line no-await-in-loop -- each token is its own case
		await expect(
			ensureWildcardRecord({ api: cf.api, domain: "porch.test", ip: "100.64.0.7", token }),
		).rejects.toThrow("needs Zone → Zone → Read and Zone → DNS → Edit on porch.test");
		expect(cf.writes).toEqual([]);
	}
});

test("a dry run reports a missing record without creating it", async () => {
	const cf = fake();

	const result = await ensureWildcardRecord({
		api: cf.api,
		domain: "porch.test",
		dryRun: true,
		ip: "100.64.0.7",
		token: TOKEN,
	});

	expect(result).toEqual({ action: "missing", ip: "100.64.0.7", name: "*.porch.test" });
	expect(cf.writes).toEqual([]);
});
