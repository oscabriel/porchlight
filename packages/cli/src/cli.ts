#!/usr/bin/env bun
// Entry point for `porch`. Commands land here as phase 1 is built test-first.
import pkg from "../package.json" with { type: "json" };

const [command] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
	console.log(pkg.version);
} else {
	console.error("porch: nothing is built yet. See https://github.com/oscabriel/porchlight");
	process.exit(1);
}
