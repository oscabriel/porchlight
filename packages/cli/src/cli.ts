#!/usr/bin/env bun
// Entry point for `porch`. Parses arguments, runs one command against the
// core, and prints the result as text or, with --json, as JSON on stdout.
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { createCaddyAdmin } from "./caddy-admin.ts";
import { PorchError } from "./errors.ts";
import { importCaddyConfig } from "./import.ts";
import { loadMachineConfig, stateDir } from "./machine.ts";
import { openPorchlight } from "./porchlight.ts";
import type { MachineConfig } from "./schema.ts";

const USAGE = `porch ${pkg.version}: named HTTPS URLs on your own domain

Usage:
  porch init                      Set this machine up, or bring it up to date
  porch add <name> <upstream>     A service porch, e.g. porch add tv http://192.168.1.10:8989
  porch serve <name> <dir>        A static porch for a folder
  porch rm <name>                 Remove a porch
  porch ls                        Every porch, lit or dark (also: porch status)
  porch url <name>                Print a porch's URL
  porch docs                      Markdown URL tables for every porch
  porch apply                     Re-render the config and swap it into Caddy
  porch rollback                  Put back what was live before the last change
  porch import caddy              Turn the running Caddy's config into porches
  porch doctor                    Check DNS, certificate, Caddy, and network

Options:
  --json                          Print JSON on stdout
  --label <text>, --about <text>  Display name and purpose, for ls and docs
  --no-cache                      (serve) Ask browsers to revalidate every file
  --domain, --email, --artifacts  (init) Answers instead of prompts
  --staging-port <port>           (init) Where porch's Caddy serves while an old Caddy
                                  still holds :443. Default 8443
  --from <file|admin>             (import) Read a Caddy JSON file, or another Caddy's admin
                                  API (http://127.0.0.1:2019, unix//path/to/admin.sock)
  --dry-run                       (import, init) Show what would happen, change nothing
                                  (init --from) Admin API of the Caddy to replace.
                                  Default http://127.0.0.1:2019
`;

class UsageError extends Error {
	override name = "UsageError";
}

const { positionals, values } = (() => {
	try {
		return parseArgs({
			allowPositionals: true,
			args: process.argv.slice(2),
			options: {
				about: { type: "string" },
				artifacts: { type: "string" },
				domain: { type: "string" },
				"dry-run": { type: "boolean" },
				email: { type: "string" },
				from: { type: "string" },
				help: { short: "h", type: "boolean" },
				json: { type: "boolean" },
				label: { type: "string" },
				"no-cache": { type: "boolean" },
				"staging-port": { type: "string" },
				version: { short: "v", type: "boolean" },
			},
		});
	} catch (error) {
		console.error(`porch: ${(error as Error).message}\n\n${USAGE}`);
		process.exit(2);
	}
})();

const json = values.json === true;
const out = (text: string, data: unknown) => {
	process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : text);
};

const need = (args: string[], count: number, usage: string) => {
	if (args.length !== count) {
		throw new UsageError(`usage: ${usage}`);
	}
	return args;
};

const described = () => ({
	...(values.about !== undefined && { about: values.about }),
	...(values.label !== undefined && { label: values.label }),
});

type Porchlight = ReturnType<typeof openPorchlight>;
interface Context {
	args: string[];
	config: MachineConfig;
	porch: Porchlight;
	url: (name: string) => string;
}

const listText = (rows: Awaited<ReturnType<Porchlight["status"]>>) => {
	if (rows.length === 0) {
		return "No porches yet. Add one with `porch add <name> <upstream>`.\n";
	}
	const width = Math.max(4, ...rows.map((r) => r.name.length));
	return rows
		.map((r) => `${r.name.padEnd(width)}  ${r.state.padEnd(4)}  ${r.kind.padEnd(9)}  ${r.url}\n`)
		.join("");
};

const ls = async ({ args, porch }: Context) => {
	need(args, 0, "porch ls");
	const rows = await porch.status();
	out(listText(rows), rows);
};

const commands: Record<string, (ctx: Context) => Promise<void>> = {
	add: async ({ args, porch, url }) => {
		const [name, upstream] = need(args, 2, "porch add <name> <upstream>") as [string, string];
		await porch.add(name, upstream, described());
		out(`${url(name)}\n`, { name, url: url(name) });
	},
	apply: async ({ args, porch }) => {
		need(args, 0, "porch apply");
		await porch.apply();
		const count = Object.keys(await porch.list()).length;
		out(`Applied ${count} porch${count === 1 ? "" : "es"}.\n`, { applied: count });
	},
	docs: async ({ args, porch }) => {
		need(args, 0, "porch docs");
		const markdown = await porch.docs();
		out(markdown, { markdown });
	},
	doctor: async ({ args, config }) => {
		need(args, 0, "porch doctor");
		const { doctor } = await import("./doctor.ts");
		const checks = await doctor(config);
		out(checks.map((c) => `${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}\n`).join(""), checks);
		if (checks.some((c) => !c.ok)) {
			process.exitCode = 1;
		}
	},
	import: async ({ args, config, porch }) => {
		const usage = "porch import caddy [--from <config.json|admin address>] [--dry-run]";
		const [source] = need(args, 1, usage);
		if (source !== "caddy") {
			throw new UsageError(`usage: ${usage}`);
		}
		const { from } = values;
		let caddyConfig: unknown;
		if (from === undefined) {
			caddyConfig = await porch.liveCaddyConfig();
		} else if (/^(?:https?:\/\/|unix\/)/u.test(from)) {
			const other = await createCaddyAdmin(from).current();
			caddyConfig = other.config;
		} else {
			caddyConfig = await Bun.file(from).json();
		}
		const { porches, skipped } = importCaddyConfig(caddyConfig, config);
		const dryRun = values["dry-run"] === true;
		if (!dryRun) {
			await porch.adopt(porches);
		}
		const names = Object.keys(porches).toSorted();
		const lines = [
			`${dryRun ? "Would import" : "Imported"} ${names.length} porches: ${names.join(", ")}`,
			...skipped.map((s) => `Skipped ${s.host}: ${s.reason}`),
		];
		out(`${lines.join("\n")}\n`, { dryRun, porches, skipped });
	},
	ls,
	rm: async ({ args, porch, url }) => {
		const [name] = need(args, 1, "porch rm <name>") as [string];
		await porch.rm(name);
		out(`Removed ${name}. ${url(name)} now shows the fallback page.\n`, { removed: name });
	},
	rollback: async ({ args, porch }) => {
		need(args, 0, "porch rollback");
		await porch.rollback();
		out("Rolled back to what was live before the last change.\n", { rolledBack: true });
	},
	serve: async ({ args, porch, url }) => {
		const [name, dir] = need(args, 2, "porch serve <name> <dir>") as [string, string];
		const noCache = values["no-cache"] === true;
		await porch.serve(name, dir, { ...(noCache && { noCache }), ...described() });
		out(`${url(name)}\n`, { name, url: url(name) });
	},
	status: ls,
	url: async ({ args, porch, url }) => {
		const [name] = need(args, 1, "porch url <name>") as [string];
		const porches = await porch.list();
		if (!porches[name]) {
			throw new PorchError("missing", `${name} is not a porch. Run \`porch ls\` to see them.`);
		}
		out(`${url(name)}\n`, { name, url: url(name) });
	},
};

const run = async () => {
	const [command, ...args] = positionals;
	if (values.version) {
		return out(`${pkg.version}\n`, { version: pkg.version });
	}
	if (values.help) {
		return out(USAGE, { usage: USAGE });
	}
	if (!command) {
		throw new UsageError("no command given");
	}
	if (command === "init") {
		need(args, 0, "porch init [--dry-run]");
		const { init } = await import("./init.ts");
		const stagingPort = Number(values["staging-port"] ?? 8443);
		if (!Number.isInteger(stagingPort) || stagingPort < 1 || stagingPort > 65_535) {
			throw new UsageError("--staging-port must be a port number");
		}
		return init({
			dryRun: values["dry-run"] === true,
			from: values.from ?? "http://127.0.0.1:2019",
			stagingPort,
			...(values.artifacts !== undefined && { artifacts: values.artifacts }),
			...(values.domain !== undefined && { domain: values.domain }),
			...(values.email !== undefined && { email: values.email }),
		});
	}
	const handler = commands[command];
	if (!handler) {
		throw new UsageError(`unknown command "${command}"`);
	}
	const config = await loadMachineConfig();
	const porch = openPorchlight({ config, stateDir: stateDir() });
	return handler({ args, config, porch, url: (name) => `https://${name}.${config.domain}` });
};

try {
	await run();
} catch (error) {
	if (error instanceof UsageError) {
		console.error(`porch: ${error.message}\n\n${USAGE}`);
		process.exit(2);
	}
	if (error instanceof PorchError) {
		if (json) {
			process.stdout.write(
				`${JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2)}\n`,
			);
		} else {
			console.error(`porch: ${error.message}`);
		}
		process.exit(1);
	}
	throw error;
}
