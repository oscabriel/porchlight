// Turns an existing Caddy JSON config (`caddy adapt` output, or GET /config/
// from a running Caddy) into porches. Anything it can't map exactly is
// reported in `skipped`, never approximated.
import { isAdminAddress, liveCaddyConfig } from "./caddy-admin.ts";
import { PorchError } from "./errors.ts";
import { expandHome } from "./paths.ts";
import type { MachineConfig, Porch } from "./schema.ts";

interface Handler {
	[key: string]: unknown;
	handler: string;
}
interface Matcher {
	host?: string[];
	method?: string[];
	path?: string[];
}
interface Route {
	handle?: Handler[];
	match?: Matcher[];
}

export interface Skipped {
	host: string;
	reason: string;
}

class UnmappableError extends Error {
	override name = "UnmappableError";
}

const routesOf = (config: unknown): Route[] => {
	const servers =
		(config as { apps?: { http?: { servers?: Record<string, { routes?: Route[] }> } } })?.apps?.http
			?.servers ?? {};
	return Object.values(servers).flatMap((server) => server.routes ?? []);
};

/** A route's handlers, looking through Caddyfile's one-subroute-per-site wrapping. */
const innerRoutes = (route: Route): Route[] => {
	const handle = route.handle ?? [];
	const [only] = handle;
	if (handle.length === 1 && only?.handler === "subroute") {
		return (only.routes as Route[] | undefined) ?? [];
	}
	return [{ handle }];
};

const dialOf = (proxy: Handler) => {
	const upstreams = (proxy.upstreams as { dial?: string }[] | undefined) ?? [];
	const [first] = upstreams;
	if (upstreams.length !== 1 || !first?.dial) {
		throw new UnmappableError("proxies to more than one upstream, which porch doesn't render");
	}
	const tls = (proxy.transport as { tls?: unknown } | undefined)?.tls !== undefined;
	return { dial: first.dial, scheme: tls ? "https" : "http" };
};

const LOCAL = new Set(["127.0.0.1", "::1", "localhost"]);

/** A local port in the lease range, or undefined for anything else. */
const localPort = (dial: string, config: MachineConfig) => {
	const cut = dial.lastIndexOf(":");
	const host = dial.slice(0, cut).replaceAll(/^\[|\]$/gu, "");
	const port = Number(dial.slice(cut + 1));
	const [low, high] = config.ports.range;
	return LOCAL.has(host) && port >= low && port <= high ? port : undefined;
};

const unknownHandler = (handlers: Handler[], known: string[]) => {
	const odd = handlers.find((h) => !known.includes(h.handler));
	if (odd) {
		throw new UnmappableError(`uses the ${odd.handler} handler, which porch doesn't render`);
	}
};

const proxyPorch = (
	proxy: Handler,
	config: MachineConfig,
	redirect?: Record<string, string>,
): Porch => {
	const { dial, scheme } = dialOf(proxy);
	const port = scheme === "http" ? localPort(dial, config) : undefined;
	if (port !== undefined && !redirect) {
		return { kind: "dev", port };
	}
	return { kind: "service", upstream: `${scheme}://${dial}`, ...(redirect && { redirect }) };
};

const staticPorch = (handlers: Handler[], config: MachineConfig): Porch => {
	const root =
		handlers.find((h) => h.handler === "vars")?.root ??
		handlers.find((h) => h.handler === "file_server")?.root;
	if (typeof root !== "string") {
		throw new UnmappableError("serves files without a fixed root");
	}
	if (expandHome(root) === expandHome(config.artifacts)) {
		return { kind: "artifacts" };
	}
	const headers = handlers.find((h) => h.handler === "headers") as
		| { response?: { set?: Record<string, string[]> } }
		| undefined;
	const noCache = headers?.response?.set?.["Cache-Control"] !== undefined;
	return { kind: "static", root, ...(noCache && { noCache }) };
};

/** One host's main route: a proxy, a redirect plus a proxy, or a file server. */
const mainPorch = (inner: Route[], config: MachineConfig): Porch => {
	const handlers = inner.flatMap((r) => r.handle ?? []);
	unknownHandler(handlers, ["reverse_proxy", "static_response", "vars", "headers", "file_server"]);

	if (handlers.some((h) => h.handler === "file_server")) {
		return staticPorch(handlers, config);
	}
	const proxy = handlers.find((h) => h.handler === "reverse_proxy");
	if (!proxy) {
		throw new UnmappableError("has no reverse_proxy or file_server to map");
	}
	const redirect: Record<string, string> = {};
	for (const route of inner) {
		const [response] = route.handle ?? [];
		if (response?.handler !== "static_response") {
			continue;
		}
		const location = (response.headers as Record<string, string[]> | undefined)?.Location?.[0];
		const paths = route.match?.[0]?.path ?? [];
		if (
			!location ||
			paths.length !== 1 ||
			![301, 302, 307, 308, "301", "302", "307", "308"].includes(response.status_code as number)
		) {
			throw new UnmappableError("returns a fixed response that isn't a single-path redirect");
		}
		redirect[paths[0] as string] = location;
	}
	return proxyPorch(proxy, config, Object.keys(redirect).length > 0 ? redirect : undefined);
};

interface HostRoute {
	inner: Route[];
	matcher: Matcher;
}

const toPorch = (routes: HostRoute[], config: MachineConfig): Porch => {
	const main = routes.filter((r) => !(r.matcher.path || r.matcher.method));
	const splits = routes.filter((r) => r.matcher.path || r.matcher.method);
	if (main.length !== 1) {
		throw new UnmappableError("has no single catch-all route");
	}
	const porch = mainPorch((main[0] as HostRoute).inner, config);
	if (splits.length === 0) {
		return porch;
	}
	if (porch.kind !== "dev") {
		throw new UnmappableError(
			"splits paths across upstreams, which porch renders only for dev porches",
		);
	}
	const split = splits.map(({ inner, matcher }) => {
		const handlers = inner.flatMap((r) => r.handle ?? []);
		unknownHandler(handlers, ["reverse_proxy"]);
		const port = localPort(dialOf(handlers[0] as Handler).dial, config);
		if (port === undefined || !matcher.path) {
			throw new UnmappableError("splits paths to something other than a local port");
		}
		return { paths: matcher.path, port, ...(matcher.method?.[0] && { method: matcher.method[0] }) };
	});
	return { ...porch, split };
};

export const importCaddyConfig = (caddyConfig: unknown, config: MachineConfig) => {
	const wildcard = `*.${config.domain}`;
	const suffix = `.${config.domain}`;
	const byHost = new Map<string, HostRoute[]>();
	const skipped: Skipped[] = [];

	const collect = (route: Route, host: string, matcher: Matcher) => {
		const name = host.slice(0, -suffix.length);
		if (!host.endsWith(suffix) || name.includes(".") || name === "*") {
			skipped.push({ host, reason: `not under ${wildcard}` });
			return;
		}
		byHost.set(host, [...(byHost.get(host) ?? []), { inner: innerRoutes(route), matcher }]);
	};

	for (const route of routesOf(caddyConfig)) {
		const hosts = route.match?.flatMap((m) => m.host ?? []) ?? [];
		if (hosts.includes(wildcard)) {
			for (const inner of innerRoutes(route)) {
				const matcher = inner.match?.[0];
				// Unmatched routes inside the site block are its compression and
				// catch-all 404. Porch renders its own of both.
				for (const host of matcher?.host ?? []) {
					collect(inner, host, matcher as Matcher);
				}
			}
			continue;
		}
		for (const host of hosts) {
			collect(route, host, route.match?.find((m) => m.host?.includes(host)) ?? {});
		}
	}

	const porches: Record<string, Porch> = {};
	for (const [host, routes] of byHost) {
		try {
			porches[host.slice(0, -suffix.length)] = toPorch(routes, config);
		} catch (error) {
			if (!(error instanceof UnmappableError)) {
				throw error;
			}
			skipped.push({ host, reason: error.message });
		}
	}
	skipped.sort((a, b) => a.host.localeCompare(b.host));
	return { porches, skipped };
};

/** Stdout of `caddy adapt` on a Caddyfile, run with the given caddy binary. */
const adaptCaddyfile = async (caddy: string, file: string) => {
	const proc = Bun.spawn([caddy, "adapt", "--config", file], { stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new PorchError("import-failed", `caddy adapt refused ${file}:\n${stderr.trim()}`);
	}
	return JSON.parse(stdout) as unknown;
};

/**
 * A Caddy config to import from: a running Caddy's admin address, a JSON
 * file (`caddy adapt` output or a saved `GET /config/`), or a Caddyfile,
 * which porch adapts with the `caddy` binary on PATH.
 */
export const readCaddyConfig = async (from: string): Promise<unknown> => {
	if (isAdminAddress(from)) {
		return liveCaddyConfig(from);
	}
	const file = Bun.file(from);
	if (!(await file.exists())) {
		throw new PorchError("import-failed", `${from} doesn't exist.`);
	}
	const text = await file.text();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		// Not JSON, so a Caddyfile.
	}
	const caddy = Bun.which("caddy", { PATH: process.env.PATH ?? "" });
	if (!caddy) {
		throw new PorchError(
			"import-failed",
			`${from} looks like a Caddyfile, and adapting it needs a \`caddy\` binary on PATH. Install Caddy, or run \`caddy adapt --config ${from} > caddy.json\` where it is and pass that file.`,
		);
	}
	return adaptCaddyfile(caddy, from);
};
