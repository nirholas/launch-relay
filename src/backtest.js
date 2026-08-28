// Historical replay.
//
// A launch bot's rules are a bet, and the only honest way to hold a bet up to
// the light before funding it is to run it against what already happened. This
// replays real pump.fun graduations through the exact same rules, mapper,
// market selector, and budget the live relay uses, and reports what it would
// have done.
//
// Two things it deliberately does NOT claim:
//
//   1. It does not predict what a relayed token would have been worth. That
//      token never existed and its price is unknowable. What it measures is
//      SELECTION: did the filter pick coins that went on to do better than the
//      ones it threw away? That is a real, checkable question, and it is the
//      one that decides whether a rule set is worth anything.
//   2. It does not model slippage, competition, or a launch's own effect on
//      the source coin. Cost is the launchpad fee plus gas, which is the part
//      that is actually deterministic.
//
// Everything else here is real data: graduations that happened, market caps
// that were reached, and the same code path that would have judged them.

import { createRules } from './rules.js';
import { createMapper } from './mapping.js';
import { createBudget } from './budget.js';
import { normalizeGraduation } from './sources/pumpfun-graduations.js';
import { fetchJson } from './http.js';

const PUMPFUN_COINS = 'https://frontend-api-v3.pump.fun/coins';
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

/**
 * Pull graduated pump.fun coins, newest first.
 *
 * `complete=true` is pump.fun's own flag for a coin whose bonding curve filled,
 * which is exactly the event the live source fires on. Paging is sequential and
 * paced: this is someone else's public API and a backtest is not an emergency.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]        Total coins to pull. Default 300.
 * @param {number} [opts.pauseMs]      Delay between pages. Default 250.
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<import('./types.js').Signal[]>}
 */
export async function fetchGraduationHistory(opts = {}) {
	const { limit = 300, pauseMs = 250, onProgress } = opts;
	const pages = Math.min(MAX_PAGES, Math.ceil(limit / PAGE_SIZE));
	const seen = new Set();
	const signals = [];

	for (let page = 0; page < pages; page++) {
		const offset = page * PAGE_SIZE;
		const url = `${PUMPFUN_COINS}?offset=${offset}&limit=${PAGE_SIZE}`
			+ '&sort=created_timestamp&order=DESC&includeNsfw=true&complete=true';
		let batch;
		try {
			batch = await fetchJson(url, { timeoutMs: 20_000 });
		} catch (err) {
			onProgress?.(`page ${page + 1} failed (${err.message}), stopping with ${signals.length} coins`);
			break;
		}
		const coins = Array.isArray(batch) ? batch : batch?.coins || [];
		if (!coins.length) break;

		for (const coin of coins) {
			if (!coin?.mint || seen.has(coin.mint)) continue;
			seen.add(coin.mint);
			const signal = toHistoricalSignal(coin);
			if (signal) signals.push(signal);
		}
		onProgress?.(`page ${page + 1}/${pages}: ${signals.length} coins`);
		if (signals.length >= limit) break;
		if (page < pages - 1) await sleep(pauseMs);
	}

	return signals.slice(0, limit);
}

/**
 * Turn a historical pump.fun coin into a signal that does not lie about what
 * was knowable.
 *
 * This is the part of a backtest that is easy to get wrong and fatal to get
 * wrong. pump.fun's listing gives a coin's market cap NOW and its peak market
 * cap EVER. Both are facts about the future relative to the graduation being
 * replayed, and feeding either one into a rule would let the filter select on
 * the answer. So they are moved out of `metrics`, where rules read, and into
 * `outcome`, where only the scoring reads them.
 *
 * What is left in `metrics` is what a live relay would genuinely have had at
 * the moment of graduation: nothing numeric. That is not a limitation of this
 * implementation, it is the actual epistemic position, and a backtest that
 * pretended otherwise would be worse than none.
 */
export function toHistoricalSignal(coin) {
	const base = normalizeGraduation(coin);
	if (!base) return null;
	const created = Number(coin.created_timestamp) || null;
	return {
		...base,
		// pump.fun does not publish a graduation timestamp, so coin creation is
		// the ordering key. It is monotonic with graduation for this cohort,
		// which is all the budget replay needs.
		at: created || base.at,
		historical: true,
		metrics: {
			marketCapUsd: null,
			athMarketCapUsd: null,
			ageSeconds: null,
			creatorLaunches: null,
			replyCount: null,
		},
		outcome: {
			athMarketCapUsd: numOrNull(coin.ath_market_cap),
			marketCapUsd: numOrNull(coin.usd_market_cap ?? coin.market_cap_usd),
			createdAt: created,
		},
	};
}

/**
 * Rules whose inputs do not exist in the historical record. Running them would
 * reject every signal (they fail closed on unknown inputs, correctly), so the
 * backtest drops them and says which ones it dropped rather than reporting a
 * pass rate of zero and letting the reader draw the wrong conclusion.
 */
export const UNBACKTESTABLE_RULES = Object.freeze([
	'minMarketCapUsd',
	'maxMarketCapUsd',
	'minAthMarketCapUsd',
	'minReplyCount',
	'maxCreatorLaunches',
	'maxSignalAgeSeconds',
	'maxAssetAgeSeconds',
]);

const numOrNull = (v) => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Replay signals through the live decision path.
 *
 * @param {object} opts
 * @param {import('./types.js').Signal[]} opts.signals
 * @param {object} [opts.rules]
 * @param {object} [opts.mapper]
 * @param {object} [opts.budget]
 * @param {{select: Function}} [opts.marketSelector]
 * @param {object[]} [opts.markets]        Live /api/stock-tokens, needed for pairing.
 * @param {bigint} [opts.costPerLaunch]    Base units. Defaults to a PAIR launch at current prices.
 * @param {number} [opts.decimals]
 * @param {string} [opts.nativeSymbol]
 * @returns {Promise<BacktestReport>}
 */
export async function backtest(opts) {
	const {
		signals, marketSelector, markets = [],
		costPerLaunch = 650_000_000_000_000n, decimals = 18, nativeSymbol = 'ETH',
	} = opts;

	// Strip the rules whose inputs the historical record cannot supply, and
	// keep the list so the report can name them.
	const requested = opts.rules?.config || opts.rules || {};
	const dropped = UNBACKTESTABLE_RULES.filter((key) => requested[key] != null);
	const testable = { ...requested };
	for (const key of dropped) delete testable[key];
	const rules = createRules(testable);
	const mapper = opts.mapper?.map ? opts.mapper : createMapper(opts.mapper);
	const budget = opts.budget?.check ? opts.budget : createBudget(opts.budget, { decimals, nativeSymbol });

	// Replay in the order the events actually happened, so cooldowns and
	// per-day caps land the way they would have live. Newest-first input would
	// silently invert every rate limit.
	const ordered = [...signals].sort((a, b) => a.at - b.at);

	const passed = [];
	const rejected = [];
	const reasonCounts = new Map();

	for (const signal of ordered) {
		const verdict = await rules.evaluate(signal, signal.at);
		if (verdict.pass) {
			passed.push(signal);
			continue;
		}
		rejected.push(signal);
		for (const reason of verdict.reasons) {
			const key = generalizeReason(reason);
			reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
		}
	}

	// Walk the passers chronologically through the budget, carrying a synthetic
	// ledger, so the report separates "my rules liked it" from "my caps would
	// have let it through".
	const history = [];
	const launched = [];
	const throttled = [];
	const walletCount = Math.max(1, opts.walletCount || 3);

	for (const signal of passed) {
		const wallet = `0x${String((launched.length % walletCount) + 1).repeat(40).slice(0, 40)}`;
		const check = budget.check({
			costBase: costPerLaunch,
			wallet,
			walletBalance: 10n ** 30n,
			history,
			now: signal.at,
		});
		if (!check.ok) {
			throttled.push({ signal, reason: check.reason });
			continue;
		}
		history.push({ status: 'launched', at: signal.at, wallet, costBase: costPerLaunch.toString() });
		launched.push(signal);
	}

	// What each launch would have become, including its stock pairing.
	const plans = [];
	for (const signal of launched) {
		let spec;
		try {
			spec = await mapper.map(signal);
		} catch (err) {
			plans.push({ signal, error: err.message });
			continue;
		}
		let selection = null;
		if (marketSelector && markets.length) {
			try {
				selection = marketSelector.select(spec, markets);
			} catch (err) {
				selection = { markets: [], rationale: `selection failed: ${err.message}`, strategy: 'error' };
			}
		}
		plans.push({ signal, spec, selection });
	}

	return {
		untestedRules: dropped,
		window: windowOf(ordered),
		scanned: ordered.length,
		passed: passed.length,
		rejected: rejected.length,
		launched: launched.length,
		throttled: throttled.length,
		passRate: ordered.length ? passed.length / ordered.length : 0,
		rejectionReasons: [...reasonCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([reason, count]) => ({ reason, count })),
		cost: {
			perLaunchBase: costPerLaunch,
			totalBase: costPerLaunch * BigInt(launched.length),
			nativeSymbol,
			decimals,
		},
		selection: compareCohorts(launched, rejected),
		pairing: summarizePairing(plans),
		plans,
		throttledSamples: throttled.slice(0, 5).map((t) => ({ symbol: t.signal.symbol, reason: t.reason })),
		best: [...launched]
			.sort((a, b) => (peak(b) || 0) - (peak(a) || 0))
			.slice(0, 5)
			.map((s) => ({
				symbol: s.symbol,
				name: s.name,
				athMarketCapUsd: peak(s),
				pairing: plans.find((p) => p.signal.id === s.id)?.selection?.rationale || null,
			})),
		missed: [...rejected]
			.sort((a, b) => (peak(b) || 0) - (peak(a) || 0))
			.slice(0, 5)
			.map((s) => ({ symbol: s.symbol, athMarketCapUsd: peak(s) })),
	};
}

/**
 * The question the whole exercise exists to answer: did the filter pick better
 * coins than it threw away? Compared on peak market cap reached after
 * graduation, which is the only outcome both cohorts share.
 *
 * Median rather than mean, because one coin that ran 100x would otherwise make
 * any filter look brilliant.
 */
function compareCohorts(selected, rejected) {
	// Read from `outcome`, never `metrics`. That separation is the whole reason
	// this number means anything.
	const ath = (list) => list
		.map((s) => s.outcome?.athMarketCapUsd ?? s.metrics?.athMarketCapUsd)
		.filter((v) => typeof v === 'number' && v > 0)
		.sort((a, b) => a - b);
	const sel = ath(selected);
	const rej = ath(rejected);
	const stats = (arr) => ({
		count: arr.length,
		median: quantile(arr, 0.5),
		p75: quantile(arr, 0.75),
		best: arr.length ? arr[arr.length - 1] : null,
	});
	const s = stats(sel);
	const r = stats(rej);
	return {
		selected: s,
		rejected: r,
		medianLift: s.median && r.median ? s.median / r.median : null,
	};
}

function summarizePairing(plans) {
	const counts = new Map();
	for (const plan of plans) {
		for (const market of plan.selection?.markets || []) {
			const prev = counts.get(market.symbol) || { symbol: market.symbol, count: 0, themed: 0 };
			prev.count++;
			if (!/no theme matched/.test(plan.selection.rationale || '')) prev.themed++;
			counts.set(market.symbol, prev);
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count);
}

// Rejection reasons carry the value that failed ("market cap 14.74usd <
// 30000usd"), which is useful per signal and useless in a histogram. Strip the
// numbers so the report groups by which rule fired.
function generalizeReason(reason) {
	return String(reason)
		.replace(/-?\d[\d,._]*(usd|s)?/g, 'N')
		.replace(/"[^"]*"/g, '"..."')
		.trim();
}

function quantile(sorted, q) {
	if (!sorted.length) return null;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function windowOf(ordered) {
	if (!ordered.length) return { from: null, to: null, hours: 0 };
	const from = ordered[0].at;
	const to = ordered[ordered.length - 1].at;
	return { from, to, hours: Math.round(((to - from) / 3_600_000) * 10) / 10 };
}

const peak = (signal) => signal.outcome?.athMarketCapUsd ?? signal.metrics?.athMarketCapUsd ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {object} BacktestReport
 * @property {string[]} untestedRules
 * @property {{from: number|null, to: number|null, hours: number}} window
 * @property {number} scanned
 * @property {number} passed
 * @property {number} rejected
 * @property {number} launched
 * @property {number} throttled
 * @property {number} passRate
 * @property {{reason: string, count: number}[]} rejectionReasons
 * @property {object} cost
 * @property {object} selection
 * @property {object[]} pairing
 * @property {object[]} plans
 * @property {object[]} best
 * @property {object[]} missed
 */
