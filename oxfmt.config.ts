import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
	extends: [ultracite],
	ignorePatterns: ["packages/cli/schema/**"],
	tabWidth: 2,
	useTabs: true,
});
