// `porch init`: set this machine up, or bring an existing setup up to date.
// It writes the machine config and the snippet, and tells the user the one
// line their Caddyfile needs. It installs nothing and stores no secrets.
// Running it again only reports what's already in place.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { importLines, starterCaddyfile } from "./caddyfile.ts";
import { ensureWildcardRecord } from "./cloudflare.ts";
import { resolvePublic } from "./dns.ts";
import { doctor, isPrivate, localAddresses } from "./doctor.ts";
import { PorchError } from "./errors.ts";
import { configPath, defaultSnippetDir, loadMachineConfig, stateDir } from "./machine.ts";
import { expandHome } from "./paths.ts";
import { openPorchlight } from "./porchlight.ts";
import { applySnippet, renderSnippet, snippetDir } from "./proxy.ts";
import { loadRegistry } from "./registry.ts";
import { SCHEMA_BASE } from "./schema.ts";
import type { MachineConfig } from "./schema.ts";

export interface InitOptions {
	artifacts?: string;
	/** The user's Caddyfile. Detected when not given. */
	caddyfile?: string;
	/** Create the wildcard record on Cloudflare now, with a token that is used once and not saved. */
	dns: boolean;
	domain?: string;
	/** Report every step without changing anything. */
	dryRun: boolean;
	/** Shell command that reloads the proxy. Detected when not given. */
	reload?: string;
}

const TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

const say = (line: string) => process.stdout.write(`${line}\n`);
const step = (line: string) => say(`\n== ${line}`);

const sh = async (cmd: string[]) => {
	try {
		const proc = Bun.spawn(cmd, { stderr: "pipe", stdout: "pipe" });
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? stdout.trim() : null;
	} catch {
		return null;
	}
};

/** A line from the terminal. Empty means the fallback, or nothing when there is none. */
const askOptional = (question: string, fallback?: string) => {
	// eslint-disable-next-line no-alert -- Bun's prompt() reads a line from the terminal
	const answer = prompt(fallback ? `${question} [${fallback}]` : question)?.trim();
	return answer || fallback;
};

const ask = (question: string, fallback?: string) => {
	const value = askOptional(question, fallback);
	if (!value) {
		throw new PorchError("init-failed", `${question}: an answer is required.`);
	}
	return value;
};

const stty = (arg: string) =>
	Bun.spawn(["stty", arg], { stdio: ["inherit", "inherit", "inherit"] }).exited;

const askSecret = async (question: string) => {
	await stty("-echo");
	try {
		return ask(question);
	} finally {
		await stty("echo");
		say("");
	}
};

const tilde = (file: string) =>
	file.startsWith(`${homedir()}/`) ? `~${file.slice(homedir().length)}` : file;

const exists = (file: string) => Bun.file(expandHome(file)).exists();

/** This machine's private address: its Tailscale address when it has one, else the first private one. */
const privateAddress = async () => {
	const tailscaleIps = await sh(["tailscale", "ip", "-4"]);
	const tailscale = tailscaleIps?.split("\n")[0];
	if (tailscale) {
		return { ip: tailscale, via: "Tailscale" };
	}
	const ip = [...localAddresses()].find((a) => isPrivate(a) && !a.startsWith("127."));
	if (!ip) {
		throw new PorchError(
			"init-failed",
			"This machine has no private IPv4 address. Join a tailnet or a LAN and run `porch init` again.",
		);
	}
	return { ip, via: "the LAN" };
};

const settleMachine = async (options: InitOptions) => {
	step("This machine");
	const existing = await loadMachineConfig().catch((error: unknown) => {
		if (error instanceof PorchError && error.code === "no-config") {
			return null;
		}
		throw error;
	});
	const domain = options.domain ?? existing?.domain ?? ask("Your domain");
	const { ip, via } = await privateAddress();
	say(`Private address ${ip} (${via})`);
	return {
		artifacts: options.artifacts ?? existing?.artifacts ?? "~/.local/share/porchlight/artifacts",
		domain,
		existing,
		ip,
	};
};

const settleDns = async (domain: string, ip: string, options: InitOptions) => {
	step(`DNS for *.${domain}`);
	const probe = `porch-init-${crypto.randomUUID().slice(0, 8)}.${domain}`;
	const answers = await resolvePublic(probe).catch(() => [] as string[]);
	if (answers.includes(ip)) {
		say(`*.${domain} → ${ip}, as the public internet sees it`);
		return;
	}
	if (!options.dns) {
		say(
			answers.length > 0
				? `*.${domain} points at ${answers.join(", ")}, not ${ip}. Point it at ${ip}: an unproxied A record.`
				: `*.${domain} doesn't resolve yet. Create an A record *.${domain} → ${ip} at your DNS provider, unproxied.`,
		);
		say(
			`With DNS on Cloudflare, \`porch init --dns\` creates it. It reads ${TOKEN_ENV} from the environment or asks for the token, uses it once, and keeps nothing.`,
		);
		return;
	}
	const token =
		process.env[TOKEN_ENV] ??
		(await askSecret(
			`Cloudflare API token (Zone → Zone → Read and Zone → DNS → Edit on ${domain})`,
		));
	const record = await ensureWildcardRecord({ domain, dryRun: options.dryRun, ip, token });
	const said = { created: "Created", kept: "Already there:", missing: "Would create" } as const;
	say(`${said[record.action]} *.${domain} → ${ip}`);
};

const CADDYFILE_CANDIDATES = [
	"~/.config/caddy/Caddyfile",
	"/etc/caddy/Caddyfile",
	"~/caddy/Caddyfile",
];

/** The Docker container that looks like Caddy, if one runs. */
const dockerCaddy = async () => {
	const ps = await sh(["docker", "ps", "--format", "{{.Names}}\t{{.Image}}"]);
	return ps
		?.split("\n")
		.map((line) => line.split("\t"))
		.find(([name, image]) => /caddy/u.test(`${name} ${image}`))?.[0];
};

const settleProxy = async (existing: MachineConfig | null, options: InitOptions) => {
	step("Your Caddy");
	const found: string[] = [];
	for (const candidate of CADDYFILE_CANDIDATES) {
		// eslint-disable-next-line no-await-in-loop -- a handful of stat calls, in order
		if (await exists(candidate)) {
			found.push(candidate);
		}
	}
	const caddyfile =
		options.caddyfile ??
		existing?.proxy.config ??
		askOptional("Path to your Caddyfile (empty: porch writes a starter one)", found[0]);
	const dir = existing?.proxy.dir ?? tilde(defaultSnippetDir());
	const guess = await (async () => {
		if (caddyfile) {
			return Bun.which("caddy") ? `caddy reload --config ${caddyfile}` : undefined;
		}
		const container = await dockerCaddy();
		return container
			? `docker exec ${container} caddy reload --config /etc/caddy/Caddyfile`
			: undefined;
	})();
	const reload =
		options.reload ??
		existing?.proxy.reload ??
		askOptional("Command that reloads Caddy (empty: you reload it yourself)", guess);
	say(caddyfile ? `Caddyfile: ${caddyfile}` : "No Caddyfile yet");
	say(
		reload ? `Reload command: ${reload}` : "No reload command: run it yourself after each change",
	);
	return {
		...(caddyfile && { config: caddyfile }),
		dir,
		kind: "caddy" as const,
		...(reload && { reload }),
	};
};

const saveMachineConfig = async (config: MachineConfig) => {
	await mkdir(path.dirname(configPath()), { recursive: true });
	await Bun.write(configPath(), `${JSON.stringify(config, null, "\t")}\n`);
};

/** Writes the snippet, and the starter Caddyfile when there's no Caddyfile. Says what the Caddyfile needs. */
const settleSnippet = async (config: MachineConfig, dryRun: boolean) => {
	step("Snippet");
	const registry = await loadRegistry(stateDir());
	const count = Object.keys(registry.porches).length;
	const dir = snippetDir(config);
	const lines = importLines(dir);
	const caddyfile = config.proxy.config;
	const text = caddyfile
		? await Bun.file(expandHome(caddyfile))
				.text()
				.catch(() => null)
		: null;
	const imported = text !== null && lines.slice(0, 2).every((l) => text.includes(l));
	if (dryRun) {
		say(`Would write ${count} porch${count === 1 ? "" : "es"} to ${tilde(dir)}`);
	} else {
		// Reload only once the Caddyfile imports the snippet. Before that a
		// reload would change nothing, and a Caddy that isn't running yet
		// would turn a setup step into an error.
		const applied = await applySnippet(
			imported ? config : { ...config, proxy: { ...config.proxy, reload: undefined } },
			renderSnippet(config, registry),
		);
		say(
			`Wrote ${count} porch${count === 1 ? "" : "es"} to ${tilde(dir)}${applied.reloaded ? " and reloaded Caddy" : ""}`,
		);
	}
	if (imported) {
		say(`${caddyfile} imports it`);
		return;
	}
	if (caddyfile) {
		say(
			`\nAdd these lines inside the *.${config.domain} block of ${caddyfile}, then reload Caddy:\n`,
		);
		for (const line of lines) {
			say(`    ${line}`);
		}
		say(
			"\nThe last one is the fallback page for names with no porch. Leave it out if you have your own catch-all.",
		);
		return;
	}
	const starter = path.join(dir, "Caddyfile");
	if (!dryRun) {
		await Bun.write(
			starter,
			starterCaddyfile({ ...config, proxy: { ...config.proxy, dir: tilde(dir) } }),
		);
	}
	say(
		`\n${dryRun ? "Would write" : "Wrote"} a starter Caddyfile to ${tilde(starter)}. It gets a wildcard certificate from Let's Encrypt over Cloudflare DNS and imports the snippet.`,
	);
	say(
		"To run it you need Caddy with the Cloudflare DNS module (https://caddyserver.com/download, or `caddy add-package github.com/caddy-dns/cloudflare`), then:\n",
	);
	say(`    CLOUDFLARE_API_TOKEN=... caddy run --config ${tilde(starter)}\n`);
	say(
		`Run it as a service however you like (systemd, Docker). Once it's up, \`porch init\` again to set the reload command, or edit ${tilde(configPath())}.`,
	);
};

export const init = async (options: InitOptions) => {
	const { dryRun } = options;
	if (dryRun) {
		say("Dry run: porch checks every step and changes nothing.");
	}
	const { artifacts, domain, existing, ip } = await settleMachine(options);
	await settleDns(domain, ip, options);
	const proxy = await settleProxy(existing, options);
	const config: MachineConfig = {
		$schema: `${SCHEMA_BASE}/config.json`,
		artifacts,
		domain,
		ports: existing?.ports ?? { range: [3001, 3999] },
		proxy,
	};
	step("Machine config");
	if (dryRun) {
		say(`Would write ${tilde(configPath())}`);
	} else {
		await saveMachineConfig(config);
		say(`Wrote ${tilde(configPath())}`);
	}
	await settleSnippet(config, dryRun);
	if (dryRun) {
		return;
	}
	step("Checking");
	for (const c of await doctor(config, stateDir())) {
		say(`${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}`);
	}
	const porch = openPorchlight({ config, stateDir: stateDir() });
	const count = Object.keys(await porch.list()).length;
	say(
		count === 0
			? "\nNo porches yet. `porch add <name> <upstream>` makes one, and `porch import caddy --from <Caddyfile>` brings in the ones you already have."
			: `\n${count} porch${count === 1 ? "" : "es"} in the registry. \`porch ls\` shows them.`,
	);
};
