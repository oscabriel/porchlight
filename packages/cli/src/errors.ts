export type PorchErrorCode =
	| "bad-config"
	| "no-config"
	| "busy"
	| "caddy-conflict"
	| "caddy-rejected"
	| "caddy-unreachable"
	| "dns-conflict"
	| "dns-denied"
	| "exists"
	| "invalid-name"
	| "missing"
	| "no-history"
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
