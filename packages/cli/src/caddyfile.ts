// Renders the registry as Caddyfile snippets for the user's own Caddy to
// import inside its wildcard site block. Three files: the porches, the dark
// page for all of them, and the optional fallback page. Nothing here touches
// TLS, listeners, or the admin API: those stay in the user's Caddyfile.
import { darkPage, esc, fallbackPage } from "./pages.ts";
import { expandHome } from "./paths.ts";
import { upstreamOf } from "./probe.ts";
import type { MachineConfig, Porch, Registry } from "./schema.ts";

export const SNIPPET_FILES = ["porches.caddy", "errors.caddy", "fallback.caddy"] as const;
export type SnippetFile = (typeof SNIPPET_FILES)[number];
export type Snippet = Record<SnippetFile, string>;

const HEADER = `# Written by porch from its registry. Edits here are lost on the next \`porch apply\`.
# Import this file inside your *.<domain> site block.
`;

// Names without a slash match in every directory, and hiding a directory hides
// everything under it.
const HIDDEN = [".git", ".env", ".env.*", "node_modules"];

/** One Caddyfile token, quoted when it has to be. */
const q = (token: string) =>
	/[\s"#{}\\]/u.test(token) || token === ""
		? `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
		: token;

const indent = (lines: string[], depth = 1) =>
	lines.map((line) => (line === "" ? line : "\t".repeat(depth) + line));

const block = (head: string, body: string[]) => [`${head} {`, ...indent(body), "}"];

const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])$/iu;

/**
 * Proxies to a service's URL. An https upstream addressed by IP or localhost
 * is a LAN app with its own self-signed cert (a NAS, a router), which can't
 * match the address, so porch skips verification for those and only those.
 */
const serviceProxy = (upstream: string, matcher = ""): string[] => {
	const url = new URL(upstream);
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	const to = `${url.hostname}:${port}`;
	const head = `reverse_proxy${matcher} `;
	if (url.protocol !== "https:") {
		return [`${head}${to}`];
	}
	const selfSigned = IP_LITERAL.test(url.hostname) || url.hostname === "localhost";
	return selfSigned
		? block(`${head}https://${to}`, block("transport http", ["tls_insecure_skip_verify"]))
		: [`${head}https://${to}`];
};

const fileServer = (root: string, noCache = false): string[] => [
	`root * ${q(expandHome(root))}`,
	// no-cache, not no-store: browsers keep the file but revalidate, so an
	// edit shows up on the next load without a hard refresh.
	...(noCache ? ["header Cache-Control no-cache"] : []),
	...block("file_server browse", [`hide ${HIDDEN.map(q).join(" ")}`]),
];

/** Inside `route`, directives run in the order written, so the catch-all goes last. */
const devHandle = (name: string, porch: Extract<Porch, { kind: "dev" }>): string[] => {
	const split = porch.split ?? [];
	const main = `reverse_proxy 127.0.0.1:${porch.port}`;
	if (split.length === 0) {
		return [main];
	}
	const routes = split.flatMap((s, i) => {
		const matcher = `@${name}-${i}`;
		const paths = `path ${s.paths.map(q).join(" ")}`;
		return [
			...(s.method ? block(matcher, [`method ${q(s.method)}`, paths]) : [`${matcher} ${paths}`]),
			`reverse_proxy ${matcher} 127.0.0.1:${s.port}`,
		];
	});
	return block("route", [...routes, main]);
};

const serviceHandle = (name: string, porch: Extract<Porch, { kind: "service" }>): string[] => {
	const redirects = Object.entries(porch.redirect ?? {});
	if (redirects.length === 0) {
		return serviceProxy(porch.upstream);
	}
	const routes = redirects.flatMap(([from, to], i) => [
		`@${name}-redirect-${i} path ${q(from)}`,
		`redir @${name}-redirect-${i} ${q(to)} 308`,
	]);
	return block("route", [...routes, ...serviceProxy(porch.upstream)]);
};

const porchHandle = (name: string, porch: Porch, config: MachineConfig): string[] => {
	switch (porch.kind) {
		case "dev": {
			return devHandle(name, porch);
		}
		case "service": {
			return serviceHandle(name, porch);
		}
		case "static": {
			return fileServer(porch.root, porch.noCache);
		}
		case "artifacts": {
			return fileServer(config.artifacts);
		}
		default: {
			throw new Error(`unknown porch kind in ${JSON.stringify(porch satisfies never)}`);
		}
	}
};

const lightHint = (porch: Porch) => {
	if (porch.kind !== "dev") {
		return "";
	}
	if (porch.start && porch.project) {
		return `Start it with <code>${esc(porch.start)}</code> in <code>${esc(porch.project)}</code>.`;
	}
	if (porch.start) {
		return `Start it with <code>${esc(porch.start)}</code>.`;
	}
	return `Start its dev server on port ${porch.port}.`;
};

const heredoc = (directive: string, html: string, trailer: string) => [
	`${directive} <<HTML`,
	...indent(html.trimEnd().split("\n")),
	`HTML ${trailer}`,
];

const sorted = (registry: Registry) =>
	Object.entries(registry.porches).toSorted(([a], [b]) => a.localeCompare(b));

const renderPorches = (config: MachineConfig, registry: Registry) => {
	const lines = sorted(registry).flatMap(([name, porch]) => [
		`@${name} host ${name}.${config.domain}`,
		...block(`handle @${name}`, porchHandle(name, porch, config)),
	]);
	return `${HEADER}${lines.length > 0 ? `\n${lines.join("\n")}\n` : ""}`;
};

// Errors a reverse_proxy raises when the upstream doesn't answer. Upstream
// responses never reach handle_errors, so these always mean "dark".
const DARK_STATUSES = "502 504";

/**
 * One dark page for every porch. A `map` on the host fills in what each
 * porch forwards to and how to light it, so the page is rendered once.
 */
const renderErrors = (config: MachineConfig, registry: Registry) => {
	const rows = sorted(registry)
		.filter(([, porch]) => porch.kind === "dev" || porch.kind === "service")
		.map(([name, porch]) =>
			[
				`${name}.${config.domain}`,
				q(esc(name)),
				q(esc(upstreamOf(config, porch))),
				q(lightHint(porch)),
			].join(" "),
		);
	const body = block(`handle_errors ${DARK_STATUSES}`, [
		...block("map {http.request.host} {porch.name} {porch.upstream} {porch.light}", [
			...rows,
			'default "" "" ""',
		]),
		'header Content-Type "text/html; charset=utf-8"',
		"header Cache-Control no-store",
		...heredoc(
			"respond",
			darkPage("{porch.name}", "{porch.upstream}", "{porch.light}"),
			"{http.error.status_code}",
		),
	]);
	return `${HEADER}\n${body.join("\n")}\n`;
};

/** The page for names with no porch. Goes last in the site block, as its catch-all. */
const renderFallback = (config: MachineConfig) => {
	const body = block("handle", [
		'header Content-Type "text/html; charset=utf-8"',
		"header Cache-Control no-store",
		...heredoc("respond", fallbackPage(config.domain), "404"),
	]);
	return `${HEADER}# Import it last: it answers every name the porches above don't.\n\n${body.join("\n")}\n`;
};

export const renderCaddySnippet = (config: MachineConfig, registry: Registry): Snippet => ({
	"errors.caddy": renderErrors(config, registry),
	"fallback.caddy": renderFallback(config),
	"porches.caddy": renderPorches(config, registry),
});

/** The lines a Caddyfile needs inside its `*.<domain>` block. */
export const importLines = (dir: string) => [
	`import ${q(`${dir}/porches.caddy`)}`,
	`import ${q(`${dir}/errors.caddy`)}`,
	`import ${q(`${dir}/fallback.caddy`)}`,
];

/**
 * A whole Caddyfile for someone with no Caddy yet: a wildcard site with a
 * DNS-01 certificate from Cloudflare, and the three imports.
 */
export const starterCaddyfile = (config: MachineConfig) =>
	`${[
		"# Caddyfile for porchlight. Yours to edit: porch only writes the imported files.",
		"# Run Caddy with CLOUDFLARE_API_TOKEN in its environment (Zone:Read and DNS:Edit on the zone).",
		"",
		...block(`*.${config.domain}`, [
			...block("tls", [
				"dns cloudflare {env.CLOUDFLARE_API_TOKEN}",
				"# Networks that intercept DNS make Caddy's own propagation check hang.",
				"# Let's Encrypt checks from outside, so wait a fixed 30s instead.",
				"propagation_timeout -1",
				"propagation_delay 30s",
			]),
			"encode zstd gzip",
			"",
			"# Your own services go here as `@name host name.<domain>` plus `handle @name`.",
			"",
			...importLines(config.proxy.dir),
		]),
	].join("\n")}\n`;
