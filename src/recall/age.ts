const millisecondsPerHour = 3_600_000;

/**
 * Hours since a memory was created: the first parseable of the record's `createdAt` and the
 * state's `firstSeenAt`, or undefined when neither parses. Shared by recall and the sweep so both
 * score the same age.
 */
export function lifetimeHours(
	createdAt: string | null | undefined,
	firstSeenAt: string | null | undefined,
	now: Date,
): number | undefined {
	const created = [createdAt, firstSeenAt]
		.map((value) => Date.parse(value ?? ""))
		.find(Number.isFinite);
	return created === undefined ? undefined : (now.getTime() - created) / millisecondsPerHour;
}
