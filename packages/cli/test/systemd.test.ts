import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { renderCaddyUnit } from "../src/systemd.ts";
import { ensureCaddy } from "./support/caddy.ts";

let dir: string | undefined;
afterEach(async () => {
	if (dir) {
		await rm(dir, { force: true, recursive: true });
	}
});

/** systemd's own check. A typo in a directive only warns, so stderr must be empty too. */
const verify = async (unit: string) => {
	dir = await mkdtemp(path.join(tmpdir(), "porch-unit-"));
	const file = path.join(dir, "porchlight-caddy.service");
	await Bun.write(file, unit);
	const proc = Bun.spawn(["systemd-analyze", "verify", "--man=no", file], {
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code, stderr: stderr.trim() };
};

test.skipIf(!Bun.which("systemd-analyze"))(
	"the Caddy unit passes systemd's own verification",
	async () => {
		const unit = renderCaddyUnit({
			caddy: await ensureCaddy(),
			envFile: "/home/someone/.config/porchlight/caddy.env",
			initialConfig: "/home/someone/.config/porchlight/caddy-initial.json",
			user: userInfo().username,
		});

		expect(await verify(unit)).toEqual({ code: 0, stderr: "" });
	},
);
