// Renders the whole Caddy JSON config from the machine config and registry.
// Porch owns all of it, including `admin`, so a load never moves the admin
// endpoint out from under the next command.
import { darkPage, esc, fallbackPage } from "./pages.ts";
import { expandHome } from "./paths.ts";
import { upstreamOf } from "./probe.ts";
import type { MachineConfig, Porch, Registry } from "./schema.ts";

type Route = Record<string, unknown>;

const hostPort = (url: string) => new URL(url).host;

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

const proxy = (dial: string) => ({ handler: "reverse_proxy", upstreams: [{ dial }] });

const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])$/iu;

/**
 * Proxies to a service's URL. An https upstream addressed by IP or localhost
 * is a LAN app with its own self-signed cert (a NAS, a router), which can't
 * match the address, so porch skips verification for those and only those.
 */
const serviceProxy = (upstream: string) => {
	const url = new URL(upstream);
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	if (url.protocol !== "https:") {
		return proxy(`${url.hostname}:${port}`);
	}
	const selfSigned = IP_LITERAL.test(url.hostname) || url.hostname === "localhost";
	return {
		...proxy(`${url.hostname}:${port}`),
		transport: { protocol: "http", tls: selfSigned ? { insecure_skip_verify: true } : {} },
	};
};

/** The routes inside one porch's host match. */
const porchRoutes = (porch: Porch): Route[] => {
	switch (porch.kind) {
		case "dev": {
			const split = (porch.split ?? []).map((s) => ({
				handle: [proxy(`127.0.0.1:${s.port}`)],
				match: [{ path: s.paths, ...(s.method && { method: [s.method] }) }],
			}));
			return [...split, { handle: [proxy(`127.0.0.1:${porch.port}`)] }];
		}
		case "service": {
			const redirects = Object.entries(porch.redirect ?? {}).map(([from, to]) => ({
				handle: [{ handler: "static_response", headers: { Location: [to] }, status_code: 308 }],
				match: [{ path: [from] }],
			}));
			return [...redirects, { handle: [serviceProxy(porch.upstream)] }];
		}
		case "static": {
			const noCache = porch.noCache
				? [{ handler: "headers", response: { set: { "Cache-Control": ["no-store"] } } }]
				: [];
			return [
				{
					handle: [
						...noCache,
						{ handler: "file_server", hide: HIDDEN, root: expandHome(porch.root) },
					],
				},
			];
		}
		default: {
			throw new Error(`porch kind ${porch.kind} is not built yet`);
		}
	}
};

const porchRoute = (host: string, porch: Porch): Route => ({
	handle: [{ handler: "subroute", routes: porchRoutes(porch) }],
	match: [{ host: [host] }],
	terminal: true,
});

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

const lightHint = (porch: Porch) => {
	if (porch.kind !== "dev") {
		return;
	}
	if (porch.start && porch.project) {
		return `Start it with <code>${esc(porch.start)}</code> in <code>${esc(porch.project)}</code>.`;
	}
	if (porch.start) {
		return `Start it with <code>${esc(porch.start)}</code>.`;
	}
	return `Start its dev server on port ${porch.port}.`;
};

const darkRoute = (
	host: string,
	name: string,
	porch: Porch,
	config: MachineConfig,
): Route | undefined => {
	if (porch.kind !== "service" && porch.kind !== "dev") {
		return undefined;
	}
	return {
		handle: [
			html("{http.error.status_code}", darkPage(name, upstreamOf(config, porch), lightHint(porch))),
		],
		match: [{ expression: DARK_STATUSES, host: [host] }],
	};
};

export const renderCaddyConfig = (config: MachineConfig, registry: Registry) => {
	const wildcard = `*.${config.domain}`;
	const routes = Object.entries(registry.porches).map(([name, porch]) =>
		porchRoute(`${name}.${config.domain}`, porch),
	);
	routes.push({ handle: [html(404, fallbackPage(config.domain))] });
	const darkRoutes = Object.entries(registry.porches).flatMap(
		([name, porch]) => darkRoute(`${name}.${config.domain}`, name, porch, config) ?? [],
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
