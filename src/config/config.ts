import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ActivationParameters, defaultActivationParameters } from "../activation/act-r.js";
import type { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import { HindsightStore } from "../store/hindsight.js";
import type { MemoryStore } from "../store/types.js";

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export interface Config {
	storeUrl: string;
	budgetTokens: number;
	topK: number;
	promptThreshold: number;
	/** Retrieval-probability threshold of intrusive thoughts; null turns them off. */
	intrusionThreshold: number | null;
	intrusionCooldown: number;
	dormancyFloor: number;
	protectedTags: string[];
	organizations: Record<string, string>;
	replayDir: string;
	stateDir: string;
	storeTimeoutMs: number;
	retainTimeoutMs: number;
	fanCacheSeconds: number;
	activation: ActivationParameters;
}

export interface LoadConfigOptions {
	env: Record<string, string | undefined>;
	/** Directory holding `config.json`; defaults to `$XDG_CONFIG_HOME/dmn`. */
	configDir?: string;
}

const numberKeys = [
	"budgetTokens",
	"topK",
	"promptThreshold",
	"intrusionCooldown",
	"dormancyFloor",
	"storeTimeoutMs",
	"retainTimeoutMs",
	"fanCacheSeconds",
] as const;

function xdgDirectory(env: LoadConfigOptions["env"], variable: string, fallback: string): string {
	const home = env.HOME ?? homedir();
	return join(env[variable] || join(home, fallback), "dmn");
}

function readFileConfig(configDir: string): Record<string, unknown> {
	const path = join(configDir, "config.json");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new ConfigError(`invalid ${path}: ${(error as Error).message}`);
	}
}

function isHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export function loadConfig(options: LoadConfigOptions): Config {
	const { env } = options;
	const storeUrl = env.DMN_STORE_URL;
	if (!storeUrl) {
		throw new ConfigError("DMN_STORE_URL is not set; point it at the memory store (or `fake:`)");
	}
	if (storeUrl !== "fake:" && !isHttpUrl(storeUrl)) {
		throw new ConfigError("DMN_STORE_URL must be an http(s) URL or fake:");
	}
	const configDir = options.configDir ?? xdgDirectory(env, "XDG_CONFIG_HOME", ".config");
	const file = readFileConfig(configDir);

	const config: Config = {
		storeUrl,
		budgetTokens: 600,
		topK: 10,
		promptThreshold: -0.5,
		intrusionThreshold: 0.5,
		intrusionCooldown: 5,
		dormancyFloor: -2.0,
		protectedTags: ["decision", "correction", "identity", "person"],
		organizations: {},
		replayDir: join(xdgDirectory(env, "XDG_DATA_HOME", ".local/share"), "replay"),
		stateDir: xdgDirectory(env, "XDG_STATE_HOME", ".local/state"),
		storeTimeoutMs: 2000,
		retainTimeoutMs: 60_000,
		fanCacheSeconds: 300,
		activation: { ...defaultActivationParameters },
	};

	for (const key of numberKeys) {
		const value = file[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new ConfigError(`config.json: "${key}" must be a number`);
		}
		config[key] = value;
	}
	// JSON has no Infinity, so null is how an operator turns intrusive thoughts off.
	const { intrusionThreshold } = file;
	if (intrusionThreshold !== undefined) {
		if (
			intrusionThreshold !== null &&
			(typeof intrusionThreshold !== "number" || !Number.isFinite(intrusionThreshold))
		) {
			throw new ConfigError('config.json: "intrusionThreshold" must be a number or null');
		}
		config.intrusionThreshold = intrusionThreshold;
	}
	const { protectedTags, organizations, replayDir, activation } = file;
	if (protectedTags !== undefined) {
		if (!Array.isArray(protectedTags) || !protectedTags.every((tag) => typeof tag === "string")) {
			throw new ConfigError('config.json: "protectedTags" must be an array of strings');
		}
		config.protectedTags = protectedTags;
	}
	if (organizations !== undefined) {
		const valid =
			typeof organizations === "object" &&
			organizations !== null &&
			!Array.isArray(organizations) &&
			Object.values(organizations).every((name) => typeof name === "string");
		if (!valid) throw new ConfigError('config.json: "organizations" must map strings to strings');
		config.organizations = organizations as Record<string, string>;
	}
	if (replayDir !== undefined) {
		if (typeof replayDir !== "string")
			throw new ConfigError('config.json: "replayDir" must be a string');
		config.replayDir = replayDir;
	}
	if (activation !== undefined) {
		if (typeof activation !== "object" || activation === null || Array.isArray(activation)) {
			throw new ConfigError('config.json: "activation" must be an object');
		}
		for (const [key, value] of Object.entries(activation)) {
			if (!(key in defaultActivationParameters)) {
				throw new ConfigError(`config.json: unknown key "activation.${key}"`);
			}
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new ConfigError(`config.json: "activation.${key}" must be a number`);
			}
			config.activation[key as keyof ActivationParameters] = value;
		}
	}
	return config;
}

/**
 * `fake:` selects a fresh in-memory store that lives and dies with the process: meant for
 * replay and tests only, since separate hook processes would never see each other's memories.
 * Anything else is a Hindsight base URL.
 */
export function createStore(config: Config): MemoryStore {
	if (config.storeUrl === "fake:") return new FakeStore();
	return new HindsightStore({
		baseUrl: config.storeUrl,
		timeoutMs: config.storeTimeoutMs,
		retainTimeoutMs: config.retainTimeoutMs,
	});
}

/** Opens the local state. Loaded lazily so `bun:sqlite` is only needed by commands that use it. */
export async function openState(config: Config, clock?: () => Date): Promise<LocalState> {
	const { LocalState } = await import("../state/state.js");
	return new LocalState({ directory: config.stateDir, ...(clock && { clock }) });
}
