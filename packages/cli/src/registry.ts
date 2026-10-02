import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { RegistrySchema } from "./schema.ts";
import type { Registry } from "./schema.ts";

export const registryPath = (stateDir: string) => path.join(stateDir, "porches.json");

export const loadRegistry = async (stateDir: string): Promise<Registry> => {
	const file = Bun.file(registryPath(stateDir));
	if (!(await file.exists())) {
		return { porches: {} };
	}
	return RegistrySchema.parse(await file.json());
};

/** Writes via a temp file and rename, so a crash never leaves half a registry. */
export const saveRegistry = async (stateDir: string, registry: Registry) => {
	await mkdir(stateDir, { recursive: true });
	const target = registryPath(stateDir);
	const temp = `${target}.${process.pid}.tmp`;
	await Bun.write(temp, `${JSON.stringify(registry, null, "\t")}\n`);
	await rename(temp, target);
};
