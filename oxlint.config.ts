import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
	extends: [core],
	overrides: [
		{
			// `expect(await thing()).toBe(...)` is the clearest way to write an assertion.
			files: ["**/test/**"],
			rules: { "unicorn/no-await-expression-member": "off" },
		},
	],
});
