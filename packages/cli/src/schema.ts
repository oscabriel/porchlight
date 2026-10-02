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

/** `~/.config/porchlight/config.json`, one per machine, written by `porch init`. */
export const MachineConfigSchema = z
	.object({
		$schema: z.string().optional(),
		acmeEmail: z.email(),
		artifacts: z.string().min(1).describe("Folder `porch publish` copies into"),
		caddy: z.object({
			admin: z
				.string()
				.min(1)
				.describe(
					"Caddy admin endpoint: a Unix socket in Caddy's form, e.g. unix//run/porchlight/caddy.sock (the porch init default), or a URL, e.g. http://127.0.0.1:2019",
				),
			listen: z
				.array(z.string().min(1))
				.min(1)
				.optional()
				.describe('Addresses Caddy serves porches on. Defaults to [":443"]'),
			managed: z.boolean().describe("True when porch installed Caddy and owns its systemd unit"),
		}),
		dns: z.object({
			provider: z.literal("cloudflare"),
			tokenEnv: z.string().min(1).describe("Name of the env var that holds the DNS API token"),
		}),
		domain: z.string().min(1).describe("The domain every porch lives under, e.g. gneiss.run"),
		network: z.literal("tailscale"),
		ports: z.object({
			range: z.tuple([Port, Port]).describe("Inclusive range porch leases dev ports from"),
		}),
		tls: z
			.object({
				issuer: z
					.enum(["acme", "internal"])
					.describe(
						"acme: a real wildcard cert via DNS-01 (default). internal: Caddy's own CA, for tests and LAN-only setups",
					),
			})
			.optional(),
	})
	.meta({ title: "Porchlight machine config" });

const SplitRoute = z.object({
	method: z.string().optional(),
	paths: z.array(z.string().min(1)).min(1),
	port: Port,
});

// Shown by `porch docs` and `porch ls`. Neither changes what Caddy serves.
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
export type Porch = z.infer<typeof PorchSchema>;
export type Registry = z.infer<typeof RegistrySchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
