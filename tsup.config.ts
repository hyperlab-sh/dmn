import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageJson = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
	version: string;
};

export default defineConfig({
	// Entry points must match package.json `exports` and `bin`.
	entry: {
		index: "src/index.ts",
		"cli/index": "src/cli/index.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	target: "node20",
	// Chunks keep `bun:sqlite` out of commands that never open the state (`--version`).
	splitting: true,
	external: ["bun:sqlite"],
	define: {
		__DMN_VERSION__: JSON.stringify(packageJson.version),
	},
});
