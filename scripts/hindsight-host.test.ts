import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "hindsight-host.sh");
const stubBin = resolve(import.meta.dir, "../fixtures/bin");

interface Dirs {
	data: string;
	state: string;
}

interface RunResult {
	code: number | null;
	out: string;
	err: string;
}

let scratch: string;
let stubLog: string;
let server: ReturnType<typeof Bun.serve>;
const livePids: number[] = [];

// Runs one verb against its own data/state dirs under the shared scratch fixture, recording
// any pid the run leaves behind so afterAll can clean up after a failing test. An env entry
// wins over the defaults, so a case can override PATH (e.g. to hide the uv stub).
async function run(verb: string, env: Record<string, string>, dirs: Dirs): Promise<RunResult> {
	rmSync(stubLog, { force: true });
	// Async spawn: the stub HTTP server lives in this process and must keep answering.
	const child = Bun.spawn(["bash", script, verb], {
		env: {
			PATH: `${stubBin}:${process.env.PATH}`,
			HOME: scratch,
			XDG_CONFIG_HOME: join(scratch, "config"),
			XDG_DATA_HOME: dirs.data,
			XDG_STATE_HOME: dirs.state,
			HOST_STUB_LOG: stubLog,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const pidFile = join(dirs.state, "dmn", "hindsight.pid");
	if (existsSync(pidFile)) {
		const pid = Number(readFileSync(pidFile, "utf8"));
		if (Number.isInteger(pid) && pid > 0 && !livePids.includes(pid)) livePids.push(pid);
	}
	return { code, out, err };
}

function freshDirs(name: string): Dirs {
	return { data: join(scratch, name, "data"), state: join(scratch, name, "state") };
}

function recorded(): string[] {
	return existsSync(stubLog) ? readFileSync(stubLog, "utf8").split("\n").filter(Boolean) : [];
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "hindsight-host-"));
	stubLog = join(scratch, "stub.log");
	server = Bun.serve({
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === "/down/health"
				? new Response("no", { status: 503 })
				: new Response("ok"),
	});
});

afterAll(() => {
	server.stop(true);
	for (const pid of livePids) {
		try {
			process.kill(pid, 9);
		} catch {
			// already gone
		}
	}
	rmSync(scratch, { recursive: true, force: true });
});

/** The process's command line once it has exec'd its final binary (polled for up to 3 s). */
async function commandLine(pid: number): Promise<string> {
	const deadline = Date.now() + 3000;
	let last = "";
	while (Date.now() < deadline) {
		last = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString();
		if (last.includes("--host")) return last;
		await Bun.sleep(25);
	}
	return last;
}

describe("hindsight-host.sh", () => {
	test("install creates the venv with uv, repeats as a no-op and exits 2 without uv", async () => {
		const dirs = freshDirs("install");
		const venv = join(dirs.data, "dmn", "hindsight");

		const first = await run("install", {}, dirs);
		expect(first.code).toBe(0);
		expect(first.out).toContain("installed hindsight-api");
		expect(recorded()).toEqual([
			`venv --python 3.12 ${venv}`,
			`pip install --python ${venv}/bin/python hindsight-api`,
		]);
		expect(existsSync(join(venv, "bin", "hindsight-api"))).toBe(true);

		const second = await run("install", {}, dirs);
		expect(second.code).toBe(0);
		expect(second.out).toContain("already installed");
		expect(recorded()).toEqual([]);

		const noUv = await run("install", { PATH: "/usr/bin:/bin" }, dirs);
		expect(noUv.code).toBe(2);
		expect(noUv.err).toContain("uv");
	});

	test("start gates on the provider, spawns the api detached, reports a live pid, stops it and cleans a stale pid", async () => {
		const dirs = freshDirs("lifecycle");
		const pidFile = join(dirs.state, "dmn", "hindsight.pid");

		const noProvider = await run("start", {}, dirs);
		expect(noProvider.code).toBe(2);
		expect(noProvider.err).toContain("HINDSIGHT_API_LLM_PROVIDER");
		expect(recorded()).toEqual([]);

		const started = await run("start", { HINDSIGHT_API_LLM_PROVIDER: "claude-code" }, dirs);
		expect(started.code).toBe(0);
		const lastLine = started.out.trim().split("\n").at(-1) ?? "";
		expect(lastLine).toMatch(/^started hindsight \(pid \d+\)$/);
		expect(recorded()[0]).toBe(`venv --python 3.12 ${join(dirs.data, "dmn", "hindsight")}`);
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).not.toThrow();
		// The child is forked before it execs the api binary; `ps` can still show the shell or
		// `[nohup]` for a few milliseconds, so wait for the command line to settle.
		expect(await commandLine(pid)).toContain("--host 127.0.0.1 --port 8888");

		const again = await run("start", { HINDSIGHT_API_LLM_PROVIDER: "claude-code" }, dirs);
		expect(again.code).toBe(0);
		expect(again.out.trim()).toBe(`already running (pid ${pid})`);

		const stopped = await run("stop", {}, dirs);
		expect(stopped.code).toBe(0);
		expect(stopped.out.trim()).toBe("stopped hindsight");
		expect(existsSync(pidFile)).toBe(false);
		expect(() => process.kill(pid, 0)).toThrow();

		const dead = Bun.spawn(["bash", "-c", "exit 0"]);
		await dead.exited;
		mkdirSync(join(dirs.state, "dmn"), { recursive: true });
		writeFileSync(pidFile, `${dead.pid}\n`);
		const stale = await run("stop", {}, dirs);
		expect(stale.code).toBe(0);
		expect(stale.out).toContain("stale");
		expect(existsSync(pidFile)).toBe(false);
	});

	test("status prints healthy and exits 0 on a 200", async () => {
		const result = await run(
			"status",
			{ HINDSIGHT_HOST_URL: `http://127.0.0.1:${server.port}` },
			freshDirs("status-ok"),
		);
		expect(result.code).toBe(0);
		expect(result.out.trim()).toBe("healthy");
	});

	test("status reads HINDSIGHT_HOST_URL from the env file and exits 1 on a 503", async () => {
		mkdirSync(join(scratch, "config", "dmn"), { recursive: true });
		writeFileSync(
			join(scratch, "config", "dmn", "hindsight.env"),
			`HINDSIGHT_HOST_URL=http://127.0.0.1:${server.port}/down\n`,
		);
		const result = await run("status", {}, freshDirs("status-env"));
		rmSync(join(scratch, "config"), { recursive: true, force: true });
		expect(result.code).toBe(1);
		expect(result.out).toContain("unhealthy");
	});
});
