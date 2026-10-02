export type PorchErrorCode =
	| "bad-config"
	| "no-config"
	| "busy"
	| "caddy-unreachable"
	| "dns-conflict"
	| "dns-denied"
	| "exists"
	| "import-failed"
	| "init-failed"
	| "invalid-name"
	| "missing"
	| "no-history"
	| "proxy-refused"
	| "reserved";

/** A refusal porch explains to the user. Nothing changed when one is thrown. */
export class PorchError extends Error {
	override name = "PorchError";
	readonly code: PorchErrorCode;

	constructor(code: PorchErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
