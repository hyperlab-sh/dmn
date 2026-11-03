import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "hindsight-host.sh");
const stubBin = resolve(import.meta.dir, "../fixtures/bin");

let scratch: string;
let dockerLog: string;
let server: ReturnType<typeof Bun.serve>;

async function run(verb: string, env: Record<string, string>) {
	rmSync(dockerLog, { force: true });
	// Async spawn: the stub HTTP server lives in this process and must keep answering.
	const child = Bun.spawn(["bash", script, verb], {
		env: {
			PATH: `${stubBin}:${process.env.PATH}`,
			HOME: scratch,
			XDG_CONFIG_HOME: join(scratch, "config"),
			DOCKER_STUB_LOG: dockerLog,
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
	return { code, out, err };
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "hindsight-host-"));
	dockerLog = join(scratch, "docker.log");
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
	rmSync(scratch, { recursive: true, force: true });
});

describe("hindsight-host.sh", () => {
	test("start without a provider exits 2 naming the variable", async () => {
		const result = await run("start", {});
		expect(result.code).toBe(2);
		expect(result.err).toContain("HINDSIGHT_API_LLM_PROVIDER");
		expect(existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "").not.toContain("run ");
	});

	test("start with a provider runs the container with the pinned arguments", async () => {
		const result = await run("start", { HINDSIGHT_API_LLM_PROVIDER: "claude-code" });
		expect(result.code).toBe(0);
		const recorded = readFileSync(dockerLog, "utf8");
		expect(recorded).toContain("-p 127.0.0.1:8888:8888");
		expect(recorded).toContain("-p 127.0.0.1:9999:9999");
		expect(recorded).toContain("--shm-size=1g");
		expect(recorded).toContain("-v hindsight-data:/home/hindsight/.pg0");
		expect(recorded).toContain("-e HINDSIGHT_API_LLM_PROVIDER");
	});

	test("start reuses an existing container instead of running a new one", async () => {
		const result = await run("start", {
			HINDSIGHT_API_LLM_PROVIDER: "claude-code",
			DOCKER_STUB_PS: "hindsight",
		});
		expect(result.code).toBe(0);
		const recorded = readFileSync(dockerLog, "utf8");
		expect(recorded).toContain("start hindsight");
		expect(recorded).not.toContain("run ");
	});

	test("status prints healthy and exits 0 on a 200", async () => {
		const result = await run("status", { HINDSIGHT_HOST_URL: `http://127.0.0.1:${server.port}` });
		expect(result.code).toBe(0);
		expect(result.out.trim()).toBe("healthy");
	});

	test("status reads HINDSIGHT_HOST_URL from the env file and exits 1 on a 503", async () => {
		mkdirSync(join(scratch, "config", "dmn"), { recursive: true });
		writeFileSync(
			join(scratch, "config", "dmn", "hindsight.env"),
			`HINDSIGHT_HOST_URL=http://127.0.0.1:${server.port}/down\n`,
		);
		const result = await run("status", {});
		rmSync(join(scratch, "config"), { recursive: true, force: true });
		expect(result.code).toBe(1);
		expect(result.out).toContain("unhealthy");
	});
});
