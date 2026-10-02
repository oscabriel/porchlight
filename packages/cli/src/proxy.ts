// The seam between porch and the proxy the user runs. A renderer turns the
// registry into snippet files for one kind of proxy; `applySnippet` writes
// them and asks the proxy to reload. If the proxy refuses, the files go back
// to what they were, so disk and the live proxy never disagree.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { renderCaddySnippet, SNIPPET_FILES } from "./caddyfile.ts";
import type { Snippet } from "./caddyfile.ts";
import { PorchError } from "./errors.ts";
import { expandHome } from "./paths.ts";
import type { MachineConfig, Registry } from "./schema.ts";

const renderers = { caddy: renderCaddySnippet } as const;

export const renderSnippet = (config: MachineConfig, registry: Registry): Snippet =>
	renderers[config.proxy.kind](config, registry);

export const snippetDir = (config: MachineConfig) => expandHome(config.proxy.dir);

export const snippetPath = (config: MachineConfig, file: keyof Snippet) =>
	path.join(snippetDir(config), file);

/** The snippet files as they are on disk. Missing files read as `null`. */
export const readSnippet = async (config: MachineConfig) => {
	const entries = await Promise.all(
		SNIPPET_FILES.map(async (file) => {
			const handle = Bun.file(snippetPath(config, file));
			return [file, (await handle.exists()) ? await handle.text() : null] as const;
		}),
	);
	return Object.fromEntries(entries) as Record<keyof Snippet, string | null>;
};

const writeSnippet = async (config: MachineConfig, snippet: Record<string, string | null>) => {
	await mkdir(snippetDir(config), { recursive: true });
	await Promise.all(
		Object.entries(snippet).map(([file, text]) =>
			text === null ? undefined : Bun.write(snippetPath(config, file as keyof Snippet), text),
		),
	);
};

/** Runs the reload command. Returns the proxy's complaint when it refuses. */
const reload = async (command: string) => {
	const proc = Bun.spawn(["sh", "-c", command], { stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return code === 0 ? null : `${stderr}${stdout}`.trim() || `exit ${code}`;
};

export interface Applied {
	/** False when there is no reload command, so the proxy still serves the old snippet. */
	reloaded: boolean;
}

/**
 * Writes the snippet and reloads the proxy. On refusal the previous snippet
 * is put back and the error names the proxy's own message, so the fix is
 * visible. With no reload command the files are written and that's all.
 */
export const applySnippet = async (config: MachineConfig, snippet: Snippet): Promise<Applied> => {
	const previous = await readSnippet(config);
	await writeSnippet(config, snippet);
	const command = config.proxy.reload;
	if (!command) {
		return { reloaded: false };
	}
	const refusal = await reload(command);
	if (refusal === null) {
		return { reloaded: true };
	}
	await writeSnippet(config, previous);
	throw new PorchError(
		"proxy-refused",
		`${config.proxy.kind} refused to reload, so nothing changed. It said:\n${refusal}\n(reload command: ${command})`,
	);
};
