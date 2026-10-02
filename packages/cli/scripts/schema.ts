// Regenerates schema/*.json from src/schema.ts. Run with `bun run schema`.
import path from "node:path";
import { z } from "zod";
import {
	SCHEMA_BASE,
	MachineConfigSchema,
	ProjectConfigSchema,
	RegistrySchema,
} from "../src/schema.ts";

const outDir = path.join(import.meta.dir, "..", "schema");

const targets = {
	"config.json": MachineConfigSchema,
	"porch.json": ProjectConfigSchema,
	"porches.json": RegistrySchema,
};

await Promise.all(
	Object.entries(targets).map(async ([file, schema]) => {
		const json = {
			$id: `${SCHEMA_BASE}/${file}`,
			...z.toJSONSchema(schema, { target: "draft-2020-12" }),
		};
		await Bun.write(path.join(outDir, file), `${JSON.stringify(json, null, "\t")}\n`);
		console.log(`wrote schema/${file}`);
	}),
);
