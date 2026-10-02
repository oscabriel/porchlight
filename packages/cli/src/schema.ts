import { z } from "zod";

/**
 * File shapes for the three JSON files porch reads. `scripts/schema.ts`
 * turns these into the published JSON Schemas in `schema/`, so editors and
 * the runtime check the same thing.
 */

export const SCHEMA_BASE = "https://unpkg.com/porchlight/schema";

// One DNS label. Worktree porches use `--` inside a label
// (`fix-ui--ristretto`), so consecutive hyphens are allowed.
export const PorchName = z
	.string()
	.regex(
		/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
		"must be one DNS label: a-z, 0-9 and -, 1 to 63 characters, no leading or trailing -",
	);

const Port = z.number().int().min(1).max(65_535);

/**
 * The reverse proxy the user runs. Porch writes a snippet into `dir` and
 * asks the proxy to reload with `reload`. It never touches the proxy's own
 * config, which is what `config` points at.
 */
const ProxySchema = z.object({
	config: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The proxy's own config file that imports the snippet, e.g. /etc/caddy/Caddyfile. `porch doctor` checks it has the import lines",
		),
	dir: z.string().min(1).describe("Folder porch writes the snippet files into"),
	kind: z.literal("caddy").describe("Which proxy the snippet is rendered for"),
	reload: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Shell command that makes the proxy load its config again, e.g. caddy reload --config /etc/caddy/Caddyfile. Leave it out to reload by hand",
		),
});

/** `~/.config/porchlight/config.json`, one per machine, written by `porch init`. */
export const MachineConfigSchema = z
	.object({
		$schema: z.string().optional(),
		artifacts: z.string().min(1).describe("Folder `porch publish` copies into"),
		domain: z.string().min(1).describe("The domain every porch lives under, e.g. gneiss.run"),
		ports: z.object({
			range: z.tuple([Port, Port]).describe("Inclusive range porch leases dev ports from"),
		}),
		proxy: ProxySchema,
	})
	.meta({ title: "Porchlight machine config" });

const SplitRoute = z.object({
	method: z.string().optional(),
	paths: z.array(z.string().min(1)).min(1),
	port: Port,
});

// Shown by `porch docs` and `porch ls`. Neither changes what the proxy serves.
const described = {
	about: z.string().optional().describe("What it's for, one line"),
	label: z.string().optional().describe("Display name, e.g. Jellyfin. Defaults to the porch name"),
};

const DevPorch = z.object({
	...described,
	kind: z.literal("dev"),
	port: Port.describe("The leased port. It never changes once assigned"),
	project: z.string().optional(),
	split: z.array(SplitRoute).optional().describe("Paths routed to a second local port"),
	start: z.string().optional().describe("Command that lights this porch, shown on its dark page"),
});

const ServicePorch = z.object({
	...described,
	kind: z.literal("service"),
	redirect: z.record(z.string(), z.string()).optional(),
	upstream: z.url(),
});

const StaticPorch = z.object({
	...described,
	kind: z.literal("static"),
	noCache: z.boolean().optional(),
	root: z.string().min(1),
});

const ArtifactsPorch = z.object({
	...described,
	kind: z.literal("artifacts"),
});

export const PorchSchema = z.discriminatedUnion("kind", [
	DevPorch,
	ServicePorch,
	StaticPorch,
	ArtifactsPorch,
]);

/** `~/.local/state/porchlight/porches.json`. Porch writes it. */
export const RegistrySchema = z
	.object({
		$schema: z.string().optional(),
		porches: z.record(PorchName, PorchSchema),
	})
	.meta({ title: "Porchlight registry" });

/** Optional `porch.json` at a project root, or a `"porch"` key in package.json. */
export const ProjectConfigSchema = z
	.object({
		$schema: z.string().optional(),
		hostEnv: z.string().optional().describe("Extra env var porch sets to the porch's host"),
		name: PorchName.optional().describe("Porch name. Defaults to the package name"),
		port: Port.optional().describe("Pin a port when something else owns it"),
		start: z.string().optional(),
	})
	.meta({ title: "Porchlight project config" });

export type MachineConfig = z.infer<typeof MachineConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxySchema>;
export type Porch = z.infer<typeof PorchSchema>;
export type Registry = z.infer<typeof RegistrySchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
