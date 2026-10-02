import type { Plugin } from "vite";

/**
 * Phase 2. Will read PORT and PORCH_HOST from the env `porch run` sets and
 * configure host, port, and strictPort. Does nothing when they are unset.
 */
export default function porchlight(): Plugin {
	return { name: "porchlight" };
}
