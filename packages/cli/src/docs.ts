// `porch docs`: the URL tables a vault or README keeps, generated from the
// registry so they can't drift from what Caddy serves.
import type { MachineConfig, Porch } from "./schema.ts";

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

const table = (header: string[], rows: string[][]) =>
	[
		`| ${header.join(" | ")} |`,
		`|${header.map((h) => "-".repeat(h.length + 2)).join("|")}|`,
		...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
	].join("\n");

export const renderDocs = (config: MachineConfig, porches: Record<string, Porch>) => {
	const sorted = Object.entries(porches).toSorted(([a], [b]) => a.localeCompare(b));
	const url = (name: string) => `https://${name}.${config.domain}`;
	const services = sorted.filter(([, p]) => p.kind !== "dev");
	const dev = sorted.flatMap(([name, p]) => (p.kind === "dev" ? [[name, p] as const] : []));

	const sections = [];
	if (services.length > 0) {
		sections.push(
			table(
				["Service", "URL", "Purpose"],
				services.map(([name, p]) => [p.label ?? name, url(name), p.about ?? ""]),
			),
		);
	}
	if (dev.length > 0) {
		const ports = (p: (typeof dev)[number][1]) =>
			[p.port, ...new Set((p.split ?? []).map((s) => s.port))].join(", ");
		sections.push(
			table(
				["Project", "URL", "Port(s)"],
				dev.map(([name, p]) => [p.label ?? name, url(name), ports(p)]),
			),
		);
	}
	return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
};
