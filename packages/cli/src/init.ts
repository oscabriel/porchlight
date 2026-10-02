// `porch init`: set this machine up, or bring an existing setup up to date.
// Every step checks before it acts, so running it again only does what's
// missing: a newer Caddy, a changed unit, a record that isn't there yet.
//
// With a Caddy already serving (found on its admin API), it moves over
// without a gap: import that Caddy's config, serve it from porch's Caddy on
// a staging port, compare every porch through both, then, once the user has
// stopped the old one, move porch's Caddy to :443 with one apply.
import { chmod, mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { createCaddyAdmin } from "./caddy-admin.ts";
import {
	downloadCaddy,
	installedCaddyVersion,
	isOlder,
	latestCaddyVersion,
} from "./caddy-install.ts";
import { ensureWildcardRecord } from "./cloudflare.ts";
import { doctor } from "./doctor.ts";
import { PorchError } from "./errors.ts";
import { importCaddyConfig } from "./import.ts";
import { configPath, loadMachineConfig, managedCaddyFiles, stateDir } from "./machine.ts";
import { openPorchlight } from "./porchlight.ts";
import { SCHEMA_BASE } from "./schema.ts";
import type { MachineConfig } from "./schema.ts";
import { MANAGED_ADMIN, renderCaddyUnit, UNIT_NAME } from "./systemd.ts";

export interface InitOptions {
	artifacts?: string;
	domain?: string;
	/** Report every step without changing anything. */
	dryRun: boolean;
	email?: string;
	/** Admin address of a Caddy already serving, to import and replace. */
	from: string;
	stagingPort: number;
}

const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;
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

/** Runs a command with sudo, on the user's terminal so sudo can ask for the password. */
const sudo = async (cmd: string[]) => {
	say(`$ sudo ${cmd.join(" ")}`);
	const proc = Bun.spawn(["sudo", ...cmd], { stdio: ["inherit", "inherit", "inherit"] });
	if ((await proc.exited) !== 0) {
		throw new PorchError("init-failed", `\`sudo ${cmd.join(" ")}\` failed. Nothing after it ran.`);
	}
};

const ask = (question: string, fallback?: string) => {
	// eslint-disable-next-line no-alert -- Bun's prompt() reads a line from the terminal
	const answer = prompt(fallback ? `${question} [${fallback}]` : question)?.trim();
	const value = answer || fallback;
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

const readEnvFile = async (file: string) => {
	const handle = Bun.file(file);
	if (!(await handle.exists())) {
		return;
	}
	const text = await handle.text();
	const line = text.split("\n").find((l) => l.startsWith(`${TOKEN_ENV}=`));
	return line?.slice(TOKEN_ENV.length + 1) || undefined;
};

const tailscaleIp = async () => {
	const out = await sh(["tailscale", "ip", "-4"]);
	const ip = out?.split("\n")[0];
	if (!ip) {
		throw new PorchError(
			"init-failed",
			"Tailscale isn't up on this machine (`tailscale ip -4` gave nothing). Start it and run `porch init` again.",
		);
	}
	return ip;
};

/** How to stop the Caddy being replaced, when it looks like a Docker container. */
const stopHint = async () => {
	const ps = await sh([
		"docker",
		"ps",
		"--format",
		'{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project.working_dir"}}',
	]);
	const caddy = ps
		?.split("\n")
		.map((line) => line.split("\t"))
		.find(([name, image]) => /caddy/u.test(`${name} ${image}`));
	if (!caddy) {
		return "Stop it the way you started it.";
	}
	const [name, , composeDir] = caddy;
	return composeDir
		? `It looks like Docker Compose in ${composeDir}:\n    docker compose --project-directory ${composeDir} down`
		: `It looks like the Docker container ${name}:\n    docker update --restart=no ${name} && docker stop ${name}`;
};

const waitFor = async (what: string, ms: number, ready: () => Promise<boolean>) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		// eslint-disable-next-line no-await-in-loop -- polling until ready
		if (await ready()) {
			return;
		}
		// eslint-disable-next-line no-await-in-loop -- polling until ready
		await Bun.sleep(500);
	}
	throw new PorchError("init-failed", `Timed out waiting for ${what}.`);
};

const answers = async (admin: string) => {
	try {
		await createCaddyAdmin(admin).current();
		return true;
	} catch {
		return false;
	}
};

const saveMachineConfig = async (config: MachineConfig) => {
	await mkdir(path.dirname(configPath()), { recursive: true });
	await Bun.write(configPath(), `${JSON.stringify(config, null, "\t")}\n`);
};

type Porchlight = ReturnType<typeof openPorchlight>;
type Check = Awaited<ReturnType<Porchlight["check"]>>[number];

const shown = (c: Check | undefined) => {
	if (!c) {
		return "-";
	}
	return "status" in c ? String(c.status) : c.error;
};

const settleMachine = async (options: InitOptions) => {
	step("This machine");
	if (process.platform !== "linux" || !(await sh(["systemctl", "--version"]))) {
		throw new PorchError("unsupported", "porch init needs Linux with systemd.");
	}
	const ip = await tailscaleIp();
	say(`Tailscale address ${ip}`);
	const existing = await loadMachineConfig().catch((error: unknown) => {
		if (error instanceof PorchError && error.code === "no-config") {
			return null;
		}
		throw error;
	});
	const domain = options.domain ?? existing?.domain ?? ask("Your domain (DNS on Cloudflare)");
	return {
		acmeEmail:
			options.email ?? existing?.acmeEmail ?? ask("Email for Let's Encrypt", `admin@${domain}`),
		artifacts: options.artifacts ?? existing?.artifacts ?? "~/.local/share/porchlight/artifacts",
		domain,
		existing,
		ip,
	};
};

const settleToken = async (domain: string, dryRun: boolean) => {
	step("Cloudflare token");
	const { envFile } = managedCaddyFiles();
	const token =
		process.env[TOKEN_ENV] ??
		(await readEnvFile(envFile)) ??
		(await askSecret(
			`Cloudflare API token (Zone → Zone → Read and Zone → DNS → Edit on ${domain})`,
		));
	if (dryRun) {
		say(`Would write the token to ${envFile}, mode 0600`);
		return token;
	}
	await mkdir(path.dirname(envFile), { recursive: true });
	await Bun.write(envFile, `${TOKEN_ENV}=${token}\n`);
	await chmod(envFile, 0o600);
	say(`Token saved in ${envFile}, mode 0600`);
	return token;
};

const RECORD_SAID = {
	created: "Created",
	kept: "Already there:",
	missing: "Would create",
} as const;

const settleDns = async (domain: string, ip: string, token: string, dryRun: boolean) => {
	step(`DNS for *.${domain}`);
	const record = await ensureWildcardRecord({ domain, dryRun, ip, token });
	say(`${RECORD_SAID[record.action]} *.${domain} → ${ip}`);
};

/** Installs or upgrades Caddy. True when the binary changed. */
const settleCaddy = async (dryRun: boolean) => {
	step("Caddy");
	const { binary } = managedCaddyFiles();
	const [installed, latest] = await Promise.all([
		installedCaddyVersion(binary),
		latestCaddyVersion(),
	]);
	if (installed && !(latest && isOlder(installed, latest))) {
		say(`Caddy ${installed} at ${binary} is current`);
		return false;
	}
	if (dryRun) {
		say(`Would download Caddy ${latest ?? "(latest)"} with the Cloudflare module to ${binary}`);
		return true;
	}
	await mkdir(path.dirname(binary), { recursive: true });
	say("Downloading Caddy with the Cloudflare module from caddyserver.com...");
	say(`Installed Caddy ${await downloadCaddy(binary, "cloudflare")} at ${binary}`);
	return true;
};

/** Writes the machine config and unit, and (re)starts porch's Caddy when anything changed. */
const settleUnit = async (config: MachineConfig, caddyChanged: boolean, dryRun: boolean) => {
	step("systemd unit");
	const files = managedCaddyFiles();
	const unit = renderCaddyUnit({
		caddy: files.binary,
		envFile: files.envFile,
		initialConfig: files.initialConfig,
		user: userInfo().username,
	});
	const current = await Bun.file(UNIT_PATH)
		.text()
		.catch(() => null);
	const unitChanged = current !== unit;
	if (dryRun) {
		say(
			unitChanged ? `Would write ${UNIT_PATH} (needs sudo):\n\n${unit}` : `${UNIT_PATH} is current`,
		);
		say(`Would write ${configPath()}`);
		return;
	}
	await Bun.write(
		files.initialConfig,
		JSON.stringify({ admin: { listen: `${MANAGED_ADMIN}|0600` } }),
	);
	await saveMachineConfig(config);
	const active = (await sh(["systemctl", "is-active", UNIT_NAME])) === "active";
	if (unitChanged) {
		const staged = path.join(path.dirname(files.initialConfig), UNIT_NAME);
		await Bun.write(staged, unit);
		say("Installing the unit needs sudo:");
		await sudo(["install", "-m", "0644", staged, UNIT_PATH]);
		await sudo(["systemctl", "daemon-reload"]);
		await sudo(["systemctl", "enable", UNIT_NAME]);
	}
	if (!active || unitChanged || caddyChanged) {
		await sudo(["systemctl", active ? "restart" : "start", UNIT_NAME]);
	}
	await waitFor("porch's Caddy to start", 30_000, () => answers(MANAGED_ADMIN));
	say(`${UNIT_NAME} is running. Its admin API is ${MANAGED_ADMIN.slice("unix/".length)}`);
};

const finish = async (porch: Porchlight, config: MachineConfig) => {
	step("Checking");
	const served = await porch.check({ port: 443, waitMs: 180_000 });
	const failed = served.filter((s) => "error" in s);
	for (const f of failed) {
		say(`  ${f.name}: ${shown(f)}`);
	}
	say(
		`${served.length - failed.length} of ${served.length} porches answer on :443 with a valid certificate`,
	);
	for (const c of await doctor(config)) {
		say(`${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}`);
	}
	say(
		`\nDone. To go back, run \`sudo systemctl disable --now ${UNIT_NAME}\` and start the old Caddy again.`,
	);
};

/** Prints old and new answers side by side. Returns how many differ. */
const compare = (before: Check[], after: Check[]) => {
	const width = Math.max(0, ...before.map((b) => b.name.length));
	let differ = 0;
	for (const b of before) {
		const a = after.find((x) => x.name === b.name);
		const same = shown(a) === shown(b);
		differ += same ? 0 : 1;
		say(`  ${same ? "  " : "!!"} ${b.name.padEnd(width)}  old ${shown(b)}  new ${shown(a)}`);
	}
	return differ;
};

const moveOver = async (
	oldCaddy: string,
	config: MachineConfig,
	options: InitOptions,
): Promise<void> => {
	step(`Moving over from the Caddy at ${oldCaddy}`);
	const { config: oldConfig } = await createCaddyAdmin(oldCaddy).current();
	const { porches, skipped } = importCaddyConfig(oldConfig, config);
	const names = Object.keys(porches).toSorted();
	say(`Its config maps to ${names.length} porches: ${names.join(", ")}`);
	for (const s of skipped) {
		say(`  Skipped ${s.host}: ${s.reason}`);
	}
	if (options.dryRun) {
		say(
			`Would serve them from porch's Caddy on :${options.stagingPort}, compare every porch through both Caddys, ask you to stop this one, then move to :443`,
		);
		return;
	}
	const porch = openPorchlight({ config, stateDir: stateDir() });
	const registered = await porch.list();
	const fresh = Object.fromEntries(Object.entries(porches).filter(([n]) => !registered[n]));
	await (Object.keys(fresh).length > 0 ? porch.adopt(fresh) : porch.apply());

	step(`Comparing every porch: old Caddy on :443, porch's on :${options.stagingPort}`);
	say("porch's Caddy is getting its own wildcard certificate. That can take a minute or two.");
	const [before, after] = await Promise.all([
		porch.check({ port: 443 }),
		porch.check({ port: options.stagingPort, waitMs: 180_000 }),
	]);
	const differ = compare(before, after);
	if (differ > 0) {
		say(
			`${differ} porch${differ === 1 ? "" : "es"} answer differently. Check them before going on.`,
		);
	}
	if (ask("Continue and move to :443? (yes/no)", "no") !== "yes") {
		say(
			`Stopped. The old Caddy still serves everything, and porch's Caddy stays on :${options.stagingPort}. Run \`porch init\` again to pick up here.`,
		);
		return;
	}

	step("Stop the old Caddy");
	say(await stopHint());
	ask("Press Enter once it's stopped", "done");
	await waitFor("the old Caddy to stop", 60_000, async () => !(await answers(oldCaddy)));
	const {
		caddy: { listen: _staging, ...caddy },
	} = config;
	const final: MachineConfig = { ...config, caddy };
	await saveMachineConfig(final);
	const moved = openPorchlight({ config: final, stateDir: stateDir() });
	await moved.apply();
	say("porch's Caddy now serves every porch on :443");
	await finish(moved, final);
};

export const init = async (options: InitOptions) => {
	const { dryRun } = options;
	if (dryRun) {
		say("Dry run: porch checks every step and changes nothing.");
	}
	const { acmeEmail, artifacts, domain, existing, ip } = await settleMachine(options);
	const token = await settleToken(domain, dryRun);
	await settleDns(domain, ip, token, dryRun);
	const caddyChanged = await settleCaddy(dryRun);

	const oldCaddy = (await answers(options.from)) ? options.from : null;
	const config: MachineConfig = {
		$schema: `${SCHEMA_BASE}/config.json`,
		acmeEmail,
		artifacts,
		caddy: {
			admin: MANAGED_ADMIN,
			managed: true,
			...(oldCaddy && { listen: [`:${options.stagingPort}`] }),
		},
		dns: { provider: "cloudflare", tokenEnv: TOKEN_ENV },
		domain,
		network: "tailscale",
		ports: existing?.ports ?? { range: [3001, 3999] },
		...(existing?.tls && { tls: existing.tls }),
	};
	await settleUnit(config, caddyChanged, dryRun);

	if (oldCaddy) {
		return moveOver(oldCaddy, config, options);
	}
	step("Porches");
	if (dryRun) {
		say("Would apply the registry to porch's Caddy on :443");
		return;
	}
	const porch = openPorchlight({ config, stateDir: stateDir() });
	await porch.apply();
	say(`Applied ${Object.keys(await porch.list()).length} porches on :443`);
	await finish(porch, config);
};
