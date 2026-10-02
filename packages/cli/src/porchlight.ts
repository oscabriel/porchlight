// The porch core. Every command that changes state goes through `change`:
// under the state-dir lock, read the registry, compute the next one, render
// the snippet from it, write it and reload the proxy, and save the registry
// only once the proxy has accepted it.
import path from "node:path";
import { PorchError } from "./errors.ts";
import { renderDocs } from "./docs.ts";
import { newestHistory, pushHistory } from "./history.ts";
import { withLock } from "./lock.ts";
import { probe, throughProxy } from "./probe.ts";
import { applySnippet, renderSnippet } from "./proxy.ts";
import type { Applied } from "./proxy.ts";
import { loadRegistry, saveRegistry } from "./registry.ts";
import { PorchName } from "./schema.ts";
import type { MachineConfig, Porch, Registry } from "./schema.ts";

type ServiceExtra = Omit<Extract<Porch, { kind: "service" }>, "kind" | "upstream">;
type StaticExtra = Omit<Extract<Porch, { kind: "static" }>, "kind" | "root">;

export interface PorchlightOptions {
	config: MachineConfig;
	/** Where the registry and its history live. */
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

/**
 * Names porch keeps for itself or that people expect to mean something else.
 * `plans` is the artifacts porch.
 */
export const RESERVED_NAMES: readonly string[] = ["www", "app", "admin", "api", "plans"];

const checkNotReserved = (name: string) => {
	if (RESERVED_NAMES.includes(name)) {
		throw new PorchError(
			"reserved",
			`${name} is reserved. Pick another name. Reserved: ${RESERVED_NAMES.join(", ")}.`,
		);
	}
};

export const openPorchlight = ({ config, stateDir }: PorchlightOptions) => {
	const change = (update: (current: Registry) => Registry): Promise<Applied> =>
		withLock(stateDir, async () => {
			const before = await loadRegistry(stateDir);
			const registry = update(before);
			const applied = await applySnippet(config, renderSnippet(config, registry));
			// A plain `porch apply` changes nothing, so rollback shouldn't step over it.
			if (JSON.stringify(registry) !== JSON.stringify(before)) {
				await pushHistory(stateDir, { at: new Date().toISOString(), registry: before });
			}
			await saveRegistry(stateDir, registry);
			return applied;
		});

	/**
	 * Adds every porch in `porches` in one apply. Refuses all of them if any
	 * name is invalid or taken. Reserved names pass, so an imported Caddy
	 * config keeps every host it had.
	 */
	const adopt = (porches: Record<string, Porch>, { reservedOk = true } = {}) =>
		change((registry) => {
			for (const name of Object.keys(porches)) {
				checkName(name);
				if (!reservedOk) {
					checkNotReserved(name);
				}
			}
			const taken = Object.keys(porches).find((name) => registry.porches[name]);
			if (taken) {
				throw new PorchError(
					"exists",
					`${taken} is already a porch. Remove it first with \`porch rm ${taken}\`.`,
				);
			}
			return { ...registry, porches: { ...registry.porches, ...porches } };
		});

	const create = (name: string, porch: Porch) => adopt({ [name]: porch }, { reservedOk: false });

	/** Adds a service porch: `https://<name>.<domain>` forwards to `upstream`. */
	const add = (name: string, upstream: string, extra: Partial<ServiceExtra> = {}) =>
		create(name, { ...extra, kind: "service", upstream });

	/** Adds a static porch: `https://<name>.<domain>` serves the files in `root`. */
	const serve = (name: string, root: string, extra: Partial<StaticExtra> = {}) =>
		create(name, { ...extra, kind: "static", root: path.resolve(root) });

	/** Renders the registry, writes the snippet, and reloads the proxy, changing nothing else. */
	const apply = () => change((registry) => registry);

	/** Puts back the registry as it was before the most recent change. Each call steps back one change. */
	const rollback = () =>
		withLock(stateDir, async () => {
			const newest = await newestHistory(stateDir);
			if (!newest) {
				throw new PorchError("no-history", "Nothing to roll back to.");
			}
			const applied = await applySnippet(config, renderSnippet(config, newest.entry.registry));
			await saveRegistry(stateDir, newest.entry.registry);
			await newest.drop();
			return applied;
		});

	/** Removes a porch. Its name falls through to the fallback page. */
	const rm = (name: string) =>
		change((registry) => {
			if (!registry.porches[name]) {
				throw new PorchError("missing", `${name} is not a porch. Run \`porch ls\` to see them.`);
			}
			const { [name]: _removed, ...porches } = registry.porches;
			return { ...registry, porches };
		});

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

	/**
	 * Every porch, sorted by name, fetched through this machine's proxy on
	 * `port` with its certificate checked: the HTTP status, or why there was
	 * none. It shows whether the proxy serves what the registry says.
	 */
	const check = async (options: { ca?: string; port: number; waitMs?: number }) => {
		const names = Object.keys(await list()).toSorted();
		return Promise.all(
			names.map(async (name) => ({
				name,
				...(await throughProxy(`${name}.${config.domain}`, options.port, options)),
			})),
		);
	};

	/** The snippet as the registry renders it now, without writing it. */
	const render = async () => renderSnippet(config, await loadRegistry(stateDir));

	/** Markdown URL tables for every porch. */
	const docs = async () => renderDocs(config, await list());

	return { add, adopt, apply, check, docs, list, render, rm, rollback, serve, status };
};
