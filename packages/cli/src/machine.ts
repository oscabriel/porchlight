// Where porch keeps its files on this machine. XDG dirs when set, else the
// usual defaults under HOME.
import { homedir } from "node:os";
import path from "node:path";
import { PorchError } from "./errors.ts";
import { MachineConfigSchema } from "./schema.ts";

const xdg = (name: "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME", fallback: string) =>
	process.env[name] || path.join(homedir(), fallback);

export const configDir = () => path.join(xdg("XDG_CONFIG_HOME", ".config"), "porchlight");
export const configPath = () => path.join(configDir(), "config.json");
export const stateDir = () => path.join(xdg("XDG_STATE_HOME", ".local/state"), "porchlight");
const dataDir = () => path.join(xdg("XDG_DATA_HOME", ".local/share"), "porchlight");

/** Files `porch init` writes for the Caddy it manages. */
export const managedCaddyFiles = () => ({
	binary: path.join(dataDir(), "caddy"),
	/** The DNS API token, mode 0600. */
	envFile: path.join(configDir(), "caddy.env"),
	/** What Caddy loads on its first start, before `--resume` has anything. */
	initialConfig: path.join(configDir(), "caddy-initial.json"),
});

export const loadMachineConfig = async () => {
	const file = Bun.file(configPath());
	if (!(await file.exists())) {
		throw new PorchError(
			"no-config",
			`No machine config at ${configPath()}. Run \`porch init\` to set this machine up.`,
		);
	}
	const parsed = MachineConfigSchema.safeParse(await file.json());
	if (!parsed.success) {
		const [issue] = parsed.error.issues;
		throw new PorchError(
			"bad-config",
			`${configPath()} is invalid at ${issue?.path.join(".") || "the top level"}: ${issue?.message}`,
		);
	}
	return parsed.data;
};
