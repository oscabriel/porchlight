import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway self-signed key pair for an https upstream, like a NAS app's own cert. */
export const selfSigned = async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "porch-tls-"));
	const key = path.join(dir, "key.pem");
	const cert = path.join(dir, "cert.pem");
	const proc = Bun.spawn(
		[
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=127.0.0.1",
		],
		{ stderr: "ignore", stdout: "ignore" },
	);
	if ((await proc.exited) !== 0) {
		throw new Error("openssl could not make a test cert");
	}
	const pair = { cert: await Bun.file(cert).text(), key: await Bun.file(key).text() };
	await rm(dir, { force: true, recursive: true });
	return pair;
};
