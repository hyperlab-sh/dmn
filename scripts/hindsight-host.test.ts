import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "hindsight-host.sh");
const stubBin = resolve(import.meta.dir, "../fixtures/bin");

let scratch: string;
let dockerLog: string;
let healthy: ReturnType<typeof Bun.serve>;
let unhealthy: ReturnType<typeof Bun.serve>;

async function run(verb: string, env: Record<string, string>) {
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
	healthy = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	unhealthy = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 503 }) });
});

afterAll(() => {
	healthy.stop(true);
	unhealthy.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

describe("hindsight-host.sh", () => {
	test("start without a provider exits 2 naming the variable", async () => {
		const result = await run("start", {});
		expect(result.code).toBe(2);
		expect(result.err).toContain("HINDSIGHT_API_LLM_PROVIDER");
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

	test("status prints healthy and exits 0 on a 200", async () => {
		const result = await run("status", { HINDSIGHT_HOST_URL: `http://127.0.0.1:${healthy.port}` });
		expect(result.code).toBe(0);
		expect(result.out.trim()).toBe("healthy");
	});

	test("status exits 1 on a non-200", async () => {
		const result = await run("status", {
			HINDSIGHT_HOST_URL: `http://127.0.0.1:${unhealthy.port}`,
		});
		expect(result.code).toBe(1);
		expect(result.out).toContain("unhealthy");
	});
});
