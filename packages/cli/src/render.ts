// Renders the whole Caddy JSON config from the machine config and registry.
// Porch owns all of it, including `admin`, so a load never moves the admin
// endpoint out from under the next command.
import { homedir } from "node:os";
import { darkPage, fallbackPage } from "./pages.ts";
import type { MachineConfig, Porch, Registry } from "./schema.ts";

type Route = Record<string, unknown>;

const hostPort = (url: string) => new URL(url).host;

const expandHome = (dir: string) =>
	dir === "~" || dir.startsWith("~/") ? homedir() + dir.slice(1) : dir;

// Names without a slash match in every directory, and hiding a directory hides
// everything under it.
const HIDDEN = [".git", ".env", ".env.*", "node_modules"];

const html = (status: number | string, body: string) => ({
	body,
	handler: "static_response",
	headers: { "Cache-Control": ["no-store"], "Content-Type": ["text/html; charset=utf-8"] },
	status_code: status,
});

const issuer = (config: MachineConfig) =>
	config.tls?.issuer === "internal"
		? { module: "internal" }
		: {
				challenges: {
					dns: {
						provider: { api_token: `{env.${config.dns.tokenEnv}}`, name: config.dns.provider },
					},
				},
				email: config.acmeEmail,
				module: "acme",
			};

const porchRoute = (host: string, porch: Porch): Route => {
	switch (porch.kind) {
		case "service": {
			return {
				handle: [{ handler: "reverse_proxy", upstreams: [{ dial: hostPort(porch.upstream) }] }],
				match: [{ host: [host] }],
				terminal: true,
			};
		}
		case "static": {
			const noCache = porch.noCache
				? [{ handler: "headers", response: { set: { "Cache-Control": ["no-store"] } } }]
				: [];
			return {
				handle: [
					...noCache,
					{ handler: "file_server", hide: HIDDEN, root: expandHome(porch.root) },
				],
				match: [{ host: [host] }],
				terminal: true,
			};
		}
		default: {
			throw new Error(`porch kind ${porch.kind} is not built yet`);
		}
	}
};

// Caddy's automatic redirects open :80 on whatever host `listen` names, even a
// test's loopback port. Porch renders the redirect itself, and only for the
// default :443 listener.
const redirectServer = {
	listen: [":80"],
	routes: [
		{
			handle: [
				{
					handler: "static_response",
					headers: { Location: ["https://{http.request.host}{http.request.uri}"] },
					status_code: 308,
				},
			],
		},
	],
};

// Errors a reverse_proxy raises when the upstream doesn't answer. Upstream
// responses never reach the error routes, so these always mean "dark".
const DARK_STATUSES = "{http.error.status_code} in [502, 504]";

const darkRoute = (host: string, name: string, porch: Porch): Route | undefined => {
	switch (porch.kind) {
		case "service": {
			return {
				handle: [html("{http.error.status_code}", darkPage(name, porch.upstream))],
				match: [{ expression: DARK_STATUSES, host: [host] }],
			};
		}
		default: {
			return undefined;
		}
	}
};

export const renderCaddyConfig = (config: MachineConfig, registry: Registry) => {
	const wildcard = `*.${config.domain}`;
	const routes = Object.entries(registry.porches).map(([name, porch]) =>
		porchRoute(`${name}.${config.domain}`, porch),
	);
	routes.push({ handle: [html(404, fallbackPage(config.domain))] });
	const darkRoutes = Object.entries(registry.porches).flatMap(
		([name, porch]) => darkRoute(`${name}.${config.domain}`, name, porch) ?? [],
	);
	const defaultListen = config.caddy.listen === undefined;

	return {
		admin: { listen: hostPort(config.caddy.admin) },
		apps: {
			http: {
				servers: {
					porchlight: {
						automatic_https: { disable_redirects: true },
						errors: {
							routes: [
								{
									handle: [{ handler: "subroute", routes: darkRoutes }],
									match: [{ host: [wildcard] }],
								},
							],
						},
						listen: config.caddy.listen ?? [":443"],
						routes: [
							{
								handle: [{ handler: "subroute", routes }],
								match: [{ host: [wildcard] }],
								terminal: true,
							},
						],
					},
					...(defaultListen && { redirect: redirectServer }),
				},
			},
			...(config.tls?.issuer === "internal" && {
				pki: { certificate_authorities: { local: { install_trust: false } } },
			}),
			tls: { automation: { policies: [{ issuers: [issuer(config)], subjects: [wildcard] }] } },
		},
	};
};
