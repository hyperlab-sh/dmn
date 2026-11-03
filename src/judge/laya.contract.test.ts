import { expect, test } from "bun:test";
import { LayaJudge } from "./laya.js";

const apiKey = process.env.LAYA_API_KEY;
const prompt = "fix the flaky rounding test, stints that cross midnight get 0 minutes";

test.skipIf(!apiKey)("ranks the useful memory above the unrelated one", async () => {
	const judge = new LayaJudge({ apiKey: apiKey as string, timeoutMs: 30_000 });
	const [useful, , unrelated] = await judge.judge(prompt, [
		{
			id: "useful",
			text: "Stints crossing midnight are split at 00:00 by splitStint; rounding happens after the split, so a stint ending at midnight yields a zero-length second half",
		},
		{ id: "background", text: "The reporting view groups rows by quest with sagas as headings" },
		{
			id: "unrelated",
			text: "The campaigns app deploys through preview environments; PRs target develop",
		},
	]);
	expect(useful?.useful).toBeGreaterThan(unrelated?.useful ?? 1);
	expect(useful?.level).toBeGreaterThan(unrelated?.level ?? 4);
});
