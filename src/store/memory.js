// In-process store. Correct for `run --once`, tests, and any host that keeps
// its own durable ledger. It forgets everything on exit, so a long-running
// relay should use the file store instead or it will re-launch coins it
// already relayed after a restart.

/** @returns {import('../types.js').Store} */
export function createMemoryStore() {
	const seen = new Set();
	const records = [];
	return {
		async seen(key) { return seen.has(key); },
		async mark(key) { seen.add(key); },
		async record(record) { records.push({ ...record, at: record.at ?? Date.now() }); },
		async history({ since = 0 } = {}) { return records.filter((r) => r.at >= since); },
	};
}
