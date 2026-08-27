// Which wallet pays for the next launch.
//
// "From different wallets" is the whole point of a pool, so rotation is a
// first-class, pure, testable decision rather than an index counter buried in
// the pool. Every strategy takes the same candidate list plus per-wallet usage
// state and returns one entry, which makes the choice reproducible in a test
// and swappable in a config file.

/**
 * @typedef {object} Usage
 * @property {number} lastUsedAt
 * @property {number} launches
 */

export const STRATEGIES = ['round-robin', 'least-recently-used', 'least-used', 'random', 'richest', 'sticky'];

/**
 * @param {{address: string}[]} candidates  Wallets that already passed balance and cooldown filters.
 * @param {object} opts
 * @param {string} opts.strategy
 * @param {Map<string, Usage>} opts.usage    Keyed by lowercased address.
 * @param {Map<string, bigint>} [opts.balances]
 * @param {() => number} [opts.random]       Injectable for deterministic tests.
 * @param {number} [opts.cursor]             Round-robin position.
 * @returns {{wallet: object|null, cursor: number}}
 */
export function pickWallet(candidates, { strategy = 'round-robin', usage = new Map(), balances, random = Math.random, cursor = 0 } = {}) {
	if (!candidates.length) return { wallet: null, cursor };
	const use = (w) => usage.get(w.address.toLowerCase()) || { lastUsedAt: 0, launches: 0 };

	switch (strategy) {
		case 'random':
			return { wallet: candidates[Math.floor(random() * candidates.length)], cursor };

		case 'least-recently-used':
			return { wallet: minBy(candidates, (w) => use(w).lastUsedAt), cursor };

		case 'least-used':
			// Ties break on staleness, so an idle pool still rotates instead of
			// hammering whichever wallet happens to sort first.
			return { wallet: minBy(candidates, (w) => use(w).launches * 1e15 + use(w).lastUsedAt), cursor };

		case 'richest':
			if (!balances) return { wallet: candidates[0], cursor };
			return { wallet: maxBy(candidates, (w) => balances.get(w.address.toLowerCase()) ?? 0n), cursor };

		case 'sticky':
			return { wallet: candidates[0], cursor };

		case 'round-robin':
		default: {
			const idx = ((cursor % candidates.length) + candidates.length) % candidates.length;
			return { wallet: candidates[idx], cursor: idx + 1 };
		}
	}
}

function minBy(list, score) {
	let best = list[0];
	let bestScore = score(best);
	for (const item of list.slice(1)) {
		const s = score(item);
		if (s < bestScore) { best = item; bestScore = s; }
	}
	return best;
}

function maxBy(list, score) {
	let best = list[0];
	let bestScore = score(best);
	for (const item of list.slice(1)) {
		const s = score(item);
		if (s > bestScore) { best = item; bestScore = s; }
	}
	return best;
}
