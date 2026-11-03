/**
 * The store adapter's error contract, shared by the real adapter and the fakes: a fake throws
 * the same error the adapter throws for the same condition, so callers skip banks identically.
 */

/** `status` is the HTTP status, or 0 when no response arrived or the data is unusable. */
export class StoreError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "StoreError";
	}
}

/** Hindsight answers 404 "Bank '<name>' not found" for a bank nobody has written to yet. */
export function isBankNotFound(error: unknown): boolean {
	return (
		error instanceof StoreError &&
		error.status === 404 &&
		/failed: 404 [\s\S]*bank/i.test(error.message)
	);
}
