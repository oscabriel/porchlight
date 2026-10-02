// The porch core. Every command that changes state goes through `change`:
// under the state-dir lock, read the registry, compute the next one, render
// the full Caddy config from it, swap that in, and save the registry only
// once Caddy has accepted it.
import path from "node:path";
import { createCaddyAdmin } from "./caddy-admin.ts";
import { PorchError } from "./errors.ts";
import { newestHistory, pushHistory } from "./history.ts";
import { withLock } from "./lock.ts";
import { probe } from "./probe.ts";
import { loadRegistry, saveRegistry } from "./registry.ts";
import { renderCaddyConfig } from "./render.ts";
import { PorchName } from "./schema.ts";
import type { MachineConfig, Porch, Registry } from "./schema.ts";

export interface PorchlightOptions {
	config: MachineConfig;
	/** Where the registry and applied-config history live. */
	stateDir: string;
}

const checkName = (name: string) => {
	if (!PorchName.safeParse(name).success) {
		throw new PorchError(
			"invalid-name",
			`"${name}" is not a valid porch name. Use one DNS label: lowercase a-z, 0-9, and -, up to 63 characters.`,
		);
	}
};

export const openPorchlight = ({ config, stateDir }: PorchlightOptions) => {
	const caddy = createCaddyAdmin(config.caddy.admin);

	const change = (update: (current: Registry) => Registry) =>
		withLock(stateDir, async () => {
			const live = await caddy.current();
			const before = await loadRegistry(stateDir);
			const registry = update(before);
			await caddy.replace(renderCaddyConfig(config, registry), live.etag);
			await pushHistory(stateDir, {
				at: new Date().toISOString(),
				caddy: live.config,
				registry: before,
			});
			await saveRegistry(stateDir, registry);
		});

	/** Adds every porch in `porches` in one apply. Refuses all of them if any name is invalid or taken. */
	const adopt = async (porches: Record<string, Porch>) => {
		for (const name of Object.keys(porches)) {
			checkName(name);
		}
		await change((registry) => {
			const taken = Object.keys(porches).find((name) => registry.porches[name]);
			if (taken) {
				throw new PorchError(
					"exists",
					`${taken} is already a porch. Remove it first with \`porch rm ${taken}\`.`,
				);
			}
			return { ...registry, porches: { ...registry.porches, ...porches } };
		});
	};

	const create = (name: string, porch: Porch) => adopt({ [name]: porch });

	/** Adds a service porch: `https://<name>.<domain>` forwards to `upstream`. */
	const add = (name: string, upstream: string) => create(name, { kind: "service", upstream });

	/** Adds a static porch: `https://<name>.<domain>` serves the files in `root`. */
	const serve = (name: string, root: string) =>
		create(name, { kind: "static", root: path.resolve(root) });

	/** Renders the registry and swaps it into Caddy, changing nothing else. */
	const apply = () => change((registry) => registry);

	/**
	 * Puts back what was live before the most recent change: Caddy's config
	 * exactly as it was, and the registry. Each call steps back one change.
	 */
	const rollback = () =>
		withLock(stateDir, async () => {
			const newest = await newestHistory(stateDir);
			if (!newest) {
				throw new PorchError("no-history", "Nothing to roll back to.");
			}
			const { entry } = newest;
			const live = await caddy.current();
			// A config without `admin` would move Caddy's admin endpoint to its
			// default, out from under every later porch command.
			const restored = {
				admin: { listen: new URL(config.caddy.admin).host },
				...(entry.caddy as object | null),
			};
			await caddy.replace(restored, live.etag);
			await saveRegistry(stateDir, entry.registry);
			await newest.drop();
		});

	/** Removes a porch. Its name falls through to the fallback page. */
	const rm = async (name: string) => {
		await change((registry) => {
			if (!registry.porches[name]) {
				throw new PorchError("missing", `${name} is not a porch. Run \`porch ls\` to see them.`);
			}
			const { [name]: _removed, ...porches } = registry.porches;
			return { ...registry, porches };
		});
	};

	/** Every porch in the registry, by name. */
	const list = async () => {
		const registry = await loadRegistry(stateDir);
		return registry.porches;
	};

	/** Every porch, sorted by name, with its URL and whether it is lit. */
	const status = async () => {
		const porches = Object.entries(await list()).toSorted(([a], [b]) => a.localeCompare(b));
		return Promise.all(
			porches.map(async ([name, porch]) => ({
				kind: porch.kind,
				name,
				state: await probe(config, porch),
				url: `https://${name}.${config.domain}`,
			})),
		);
	};

	return { add, adopt, apply, list, rm, rollback, serve, status };
};
