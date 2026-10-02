// A lock on the state dir, so concurrent porch processes take turns between
// reading the registry and reloading the proxy. mkdir is atomic. The holder's
// PID lives inside, so a lock left by a dead process can be broken.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PorchError } from "./errors.ts";

const WAIT_MS = 10_000;
const POLL_MS = 25;

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const holder = async (dir: string) => {
	const text = await readFile(path.join(dir, "pid"), "utf-8").catch(() => "");
	const pid = Number(text);
	return text && Number.isInteger(pid) ? pid : undefined;
};

/**
 * Breaks a dead holder's lock. Two waiters can both see the same dead PID,
 * and if both removed the dir, the second would delete the lock the first
 * had just taken. Renaming first is atomic, so only one of them wins and the
 * other finds nothing to break.
 */
const breakLock = async (dir: string) => {
	const stale = `${dir}.stale-${process.pid}-${Date.now()}`;
	try {
		await rename(dir, stale);
	} catch {
		return;
	}
	await rm(stale, { force: true, recursive: true });
};

export const withLock = async <T>(stateDir: string, fn: () => Promise<T>): Promise<T> => {
	await mkdir(stateDir, { recursive: true });
	const dir = path.join(stateDir, "lock");
	const deadline = Date.now() + WAIT_MS;

	for (;;) {
		try {
			// eslint-disable-next-line no-await-in-loop -- waiting our turn
			await mkdir(dir);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			// eslint-disable-next-line no-await-in-loop -- waiting our turn
			const pid = await holder(dir);
			if (pid !== undefined && !alive(pid)) {
				// eslint-disable-next-line no-await-in-loop -- breaking a dead holder's lock
				await breakLock(dir);
				continue;
			}
			if (Date.now() > deadline) {
				throw new PorchError(
					"busy",
					`Another porch command (pid ${pid ?? "unknown"}) has held ${dir} for over ${WAIT_MS / 1000}s.`,
				);
			}
			// eslint-disable-next-line no-await-in-loop -- waiting our turn
			await Bun.sleep(POLL_MS);
		}
	}

	try {
		await writeFile(path.join(dir, "pid"), String(process.pid));
		return await fn();
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
};
