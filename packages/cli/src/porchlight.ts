// The porch core. Every command that changes state goes through `change`:
// under the state-dir lock, read the registry, compute the next one, render
// the full Caddy config from it, swap that in, and save the registry only
// once Caddy has accepted it.
import { createCaddyAdmin } from "./caddy-admin.ts";
import { PorchError } from "./errors.ts";
import { withLock } from "./lock.ts";
import { loadRegistry, saveRegistry } from "./registry.ts";
import { renderCaddyConfig } from "./render.ts";
import { PorchName } from "./schema.ts";
import type { MachineConfig, Registry } from "./schema.ts";

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
			const registry = update(await loadRegistry(stateDir));
			await caddy.replace(renderCaddyConfig(config, registry), await caddy.etag());
			await saveRegistry(stateDir, registry);
		});

	/** Adds a service porch: `https://<name>.<domain>` forwards to `upstream`. */
	const add = async (name: string, upstream: string) => {
		checkName(name);
		await change((registry) => {
			if (registry.porches[name]) {
				throw new PorchError(
					"exists",
					`${name} is already a porch. Remove it first with \`porch rm ${name}\`.`,
				);
			}
			return {
				...registry,
				porches: { ...registry.porches, [name]: { kind: "service", upstream } },
			};
		});
	};

	/** Every porch in the registry, by name. */
	const list = async () => {
		const registry = await loadRegistry(stateDir);
		return registry.porches;
	};

	return { add, list };
};
