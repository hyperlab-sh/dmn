export type Manifest = { path: string; content: string };

/** File names `scanCueInput` reads at the repository root and cwd. */
export const manifestFileNames = [
	"package.json",
	"tsconfig.json",
	"Cargo.toml",
	"pyproject.toml",
] as const;

/** File extensions that count as a manifest by their presence alone. */
export const manifestExtensions = [".marko"] as const;

const packageManagers = ["bun", "pnpm", "yarn", "npm"];

function baseName(path: string): string {
	return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function packageJsonStack(content: string): { names: string[]; typescript: boolean } {
	let parsed: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(content);
		if (value && typeof value === "object") parsed = value as Record<string, unknown>;
	} catch {
		// A broken package.json still says "javascript".
	}
	const names = ["javascript"];
	const packageManager = typeof parsed.packageManager === "string" ? parsed.packageManager : "";
	const manager = packageManagers.find((name) => packageManager.startsWith(`${name}@`));
	if (manager) names.push(manager);
	const dependencies = {
		...(parsed.dependencies as object | undefined),
		...(parsed.devDependencies as object | undefined),
	};
	return { names, typescript: "typescript" in dependencies };
}

/** Stack labels (sorted, unique) from the manifests found at the repository root and cwd. */
export function detectStack(manifests: Manifest[]): string[] {
	const stack = new Set<string>();
	let typescript = false;
	for (const { path, content } of manifests) {
		const name = baseName(path);
		if (name === "package.json") {
			const found = packageJsonStack(content);
			for (const label of found.names) stack.add(label);
			typescript ||= found.typescript;
		} else if (name === "tsconfig.json") typescript = true;
		else if (name === "Cargo.toml") stack.add("rust");
		else if (name === "pyproject.toml") stack.add("python");
		else if (name.endsWith(".marko")) stack.add("marko");
	}
	if (typescript) {
		stack.add("typescript");
		stack.delete("javascript");
	}
	return [...stack].sort();
}
