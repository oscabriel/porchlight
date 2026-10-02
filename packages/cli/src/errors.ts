export type PorchErrorCode =
	| "busy"
	| "caddy-conflict"
	| "caddy-rejected"
	| "caddy-unreachable"
	| "exists"
	| "invalid-name"
	| "missing"
	| "no-history";

/** A refusal porch explains to the user. Nothing changed when one is thrown. */
export class PorchError extends Error {
	override name = "PorchError";
	readonly code: PorchErrorCode;

	constructor(code: PorchErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
