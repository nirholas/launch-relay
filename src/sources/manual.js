// Manual source.
//
// The same pipeline, fed by hand. Useful for three things: launching one coin
// with the relay's own wallet rotation and guards, replaying a signal that a
// live rung dropped, and testing rules against a fixture without waiting for
// the market to produce one.

/**
 * @param {Array<Partial<import('../types.js').Signal>>} entries
 * @param {{kind?: string, chain?: string}} [opts]
 * @returns {import('../types.js').Source}
 */
export function createManualSource(entries, opts = {}) {
	const { kind = 'manual', chain = 'manual' } = opts;
	const queue = entries.map((entry, i) => ({
		id: entry.id || `manual:${entry.symbol || entry.address || i}`,
		source: 'manual',
		kind: entry.kind || kind,
		chain: entry.chain || chain,
		at: entry.at ?? Date.now(),
		links: { twitter: null, telegram: null, website: null },
		metrics: {},
		...entry,
	}));

	return {
		id: 'manual',
		chain,
		async poll() {
			return queue.splice(0, queue.length);
		},
		pollIntervalMs: 1_000,
	};
}
