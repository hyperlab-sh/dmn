import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ActivationParameters, defaultActivationParameters } from "../activation/act-r.js";
import { LayaJudge } from "../judge/laya.js";
import type { Judge } from "../judge/types.js";
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

export interface JudgeConfig {
	provider: "none" | "laya";
	/** `useful` in `replay judge` when P(useful) is at least this. */
	threshold: number;
	/** Bar for the intrusive path, read by the judge gate. */
	intrusionThreshold: number;
	baseUrl?: string;
	timeoutMs: number;
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
	/** Store limit for the intrusive recall, which runs after every tool call. */
	intrusionTimeoutMs: number;
	retainTimeoutMs: number;
	fanCacheSeconds: number;
	activation: ActivationParameters;
	judge: JudgeConfig;
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
	"intrusionTimeoutMs",
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
		intrusionTimeoutMs: 300,
		retainTimeoutMs: 60_000,
		fanCacheSeconds: 300,
		activation: { ...defaultActivationParameters },
		judge: { provider: "none", threshold: 0.5, intrusionThreshold: 0.7, timeoutMs: 5000 },
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
	if (file.judge !== undefined) config.judge = readJudge(file.judge, config.judge);
	return config;
}

function readJudge(value: unknown, defaults: JudgeConfig): JudgeConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ConfigError('config.json: "judge" must be an object');
	}
	const judge: JudgeConfig = { ...defaults };
	for (const [key, entry] of Object.entries(value)) {
		switch (key) {
			case "provider":
				if (entry !== "none" && entry !== "laya") {
					throw new ConfigError('config.json: "judge.provider" must be "none" or "laya"');
				}
				judge.provider = entry;
				break;
			case "threshold":
			case "intrusionThreshold":
				if (typeof entry !== "number" || !(entry >= 0 && entry <= 1)) {
					throw new ConfigError(`config.json: "judge.${key}" must be a number from 0 to 1`);
				}
				judge[key] = entry;
				break;
			case "timeoutMs":
				if (typeof entry !== "number" || !(entry > 0) || !Number.isFinite(entry)) {
					throw new ConfigError('config.json: "judge.timeoutMs" must be a positive number');
				}
				judge.timeoutMs = entry;
				break;
			case "baseUrl":
				if (typeof entry !== "string" || !isHttpUrl(entry)) {
					throw new ConfigError('config.json: "judge.baseUrl" must be an http(s) URL');
				}
				judge.baseUrl = entry;
				break;
			default:
				throw new ConfigError(`config.json: unknown key "judge.${key}"`);
		}
	}
	return judge;
}

/**
 * The configured judge, or undefined for provider `none`. The key comes from the environment
 * only and has no default.
 */
export function createJudge(
	config: Config,
	env: Record<string, string | undefined>,
): Judge | undefined {
	if (config.judge.provider === "none") return undefined;
	const apiKey = env.LAYA_API_KEY;
	if (!apiKey) {
		throw new ConfigError(
			'LAYA_API_KEY is not set; export it to use judge provider "laya" (the key is read from the environment only)',
		);
	}
	return new LayaJudge({
		apiKey,
		timeoutMs: config.judge.timeoutMs,
		...(config.judge.baseUrl && { baseUrl: config.judge.baseUrl }),
	});
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
