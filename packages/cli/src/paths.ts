import { homedir } from "node:os";

/** Expands a leading `~`. Registry and config paths may use it. */
export const expandHome = (dir: string) =>
	dir === "~" || dir.startsWith("~/") ? homedir() + dir.slice(1) : dir;
