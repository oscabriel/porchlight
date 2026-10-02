import { expect, test } from "bun:test";
import { importCaddyConfig } from "../src/import.ts";
import type { MachineConfig, Porch } from "../src/schema.ts";
import adapted from "./fixtures/caddyfile-adapted.json" with { type: "json" };

// The fixture is `caddy adapt` output for a real hand-written Caddyfile (one
// `*.example.com` site block of host matchers), with names and addresses scrubbed.
const config: MachineConfig = {
	acmeEmail: "admin@example.com",
	artifacts: "/home/me/Developer/agent-artifacts",
	caddy: { admin: "http://127.0.0.1:2019", managed: true },
	dns: { provider: "cloudflare", tokenEnv: "CLOUDFLARE_API_TOKEN" },
	domain: "example.com",
	network: "tailscale",
	ports: { range: [3001, 3999] },
};

const service = (upstream: string): Porch => ({ kind: "service", upstream });

test("imports every host of a wildcard-site Caddyfile as a porch", () => {
	const result = importCaddyConfig(adapted, config);

	expect(result.skipped).toEqual([]);
	expect(result.porches).toEqual({
		books: service("http://192.168.1.10:5000"),
		budget: service("http://192.168.1.10:5006"),
		code: service("http://localhost:4096"),
		depot: { kind: "static", noCache: true, root: "/home/me/Developer/projects/teach-depot" },
		dns: { kind: "service", redirect: { "/": "/admin/" }, upstream: "http://192.168.1.10:8800" },
		files: service("http://192.168.1.10:8099"),
		home: service("http://192.168.1.10:8123"),
		jev: service("http://localhost:1337"),
		library: service("http://192.168.1.10:8787"),
		listen: service("http://192.168.1.10:13378"),
		movies: service("http://192.168.1.10:7878"),
		nouveau: { kind: "dev", port: 3004 },
		nzb: service("http://192.168.1.10:8282"),
		photos: service("http://localhost:2283"),
		plans: { kind: "artifacts" },
		portfolio: { kind: "dev", port: 3005 },
		read: service("http://localhost:8001"),
		ristretto: { kind: "dev", port: 3001 },
		search: service("http://192.168.1.10:9696"),
		seer: service("http://192.168.1.10:5056"),
		subs: service("http://192.168.1.10:6767"),
		terminal: service("http://192.168.1.10:7681"),
		thinkspace: {
			kind: "dev",
			port: 3002,
			split: [
				{ paths: ["/rpc*", "/api/auth*", "/api-reference*"], port: 3003 },
				{ method: "POST", paths: ["/ai"], port: 3003 },
			],
		},
		torrent: service("http://192.168.1.10:8181"),
		tv: service("http://192.168.1.10:8989"),
		watch: service("http://localhost:8096"),
		zima: service("http://192.168.1.10:80"),
	} satisfies Record<string, Porch>);
});

test("reports hosts it can't map instead of guessing", () => {
	const withAuth = {
		apps: {
			http: {
				servers: {
					srv0: {
						listen: [":443"],
						routes: [
							{
								handle: [
									{
										handler: "subroute",
										routes: [
											{
												handle: [
													{
														handler: "subroute",
														routes: [
															{
																handle: [
																	{ handler: "authentication" },
																	{
																		handler: "reverse_proxy",
																		upstreams: [{ dial: "localhost:9000" }],
																	},
																],
															},
														],
													},
												],
												match: [{ host: ["secret.example.com"] }],
											},
											{
												handle: [
													{
														handler: "subroute",
														routes: [
															{
																handle: [
																	{
																		handler: "reverse_proxy",
																		upstreams: [{ dial: "localhost:8096" }],
																	},
																],
															},
														],
													},
												],
												match: [{ host: ["watch.example.com"] }],
											},
										],
									},
								],
								match: [{ host: ["*.example.com"] }],
								terminal: true,
							},
							{
								handle: [{ body: "other", handler: "static_response" }],
								match: [{ host: ["other.org"] }],
							},
						],
					},
				},
			},
		},
	};

	const result = importCaddyConfig(withAuth, config);

	expect(result.porches).toEqual({ watch: service("http://localhost:8096") });
	expect(result.skipped).toEqual([
		{ host: "other.org", reason: "not under *.example.com" },
		{
			host: "secret.example.com",
			reason: "uses the authentication handler, which porch doesn't render",
		},
	]);
});
