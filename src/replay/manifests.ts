import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, manifestExtensions, manifestFileNames } from "../cue/stack.js";

/** Manifests of one directory, for the cue's stack: the recorded cwd is never read. */
export function readManifests(directory: string): Manifest[] {
	const manifests: Manifest[] = [];
	for (const name of readdirSync(directory).sort()) {
		const path = join(directory, name);
		if ((manifestFileNames as readonly string[]).includes(name)) {
			manifests.push({ path, content: readFileSync(path, "utf8") });
		} else if (manifestExtensions.some((extension) => name.endsWith(extension))) {
			manifests.push({ path, content: "" });
		}
	}
	return manifests;
}
