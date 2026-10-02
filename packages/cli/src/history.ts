// What was live before each change: Caddy's config as Caddy reported it, and
// the registry. Rollback pops the newest entry. Callers hold the state lock.
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Registry } from "./schema.ts";

const KEEP = 20;

export interface HistoryEntry {
	at: string;
	/** Caddy's whole config, from `GET /config/`. `null` when Caddy had none. */
	caddy: unknown;
	registry: Registry;
}

const historyDir = (stateDir: string) => path.join(stateDir, "history");

// Zero-padded sequence numbers, so sorting by name sorts by age.
const entries = async (stateDir: string) => {
	const names = await readdir(historyDir(stateDir)).catch(() => [] as string[]);
	return names.filter((name) => /^\d{8}\.json$/u.test(name)).toSorted();
};

export const pushHistory = async (stateDir: string, entry: HistoryEntry) => {
	const dir = historyDir(stateDir);
	await mkdir(dir, { recursive: true });
	const existing = await entries(stateDir);
	const next = existing.length > 0 ? Number(existing.at(-1)?.slice(0, 8)) + 1 : 1;
	await Bun.write(
		path.join(dir, `${String(next).padStart(8, "0")}.json`),
		`${JSON.stringify(entry, null, "\t")}\n`,
	);
	const stale = existing.slice(0, Math.max(0, existing.length + 1 - KEEP));
	await Promise.all(stale.map((name) => rm(path.join(dir, name))));
};

/** The newest entry, or undefined when there is none. */
export const newestHistory = async (stateDir: string) => {
	const names = await entries(stateDir);
	const name = names.at(-1);
	if (!name) {
		return;
	}
	const file = path.join(historyDir(stateDir), name);
	const entry = (await Bun.file(file).json()) as HistoryEntry;
	return { drop: () => rm(file), entry };
};
