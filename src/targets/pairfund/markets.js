// Which stock markets a relayed coin gets paired with.
//
// This is the decision PAIR has that other launchpads do not. A launch picks
// one to five Robinhood Stock Tokens, each gets its own permanently locked
// Uniswap V4 pool, and the weights split the fixed one billion supply between
// them. The pairing is launch liquidity, not backing, but it is also the
// coin's whole identity on the platform: a dog coin paired against SPY reads
// as noise, the same coin paired against TSLA reads as a joke someone gets.
//
// So the strategies here range from "do what I said" to "read the coin and
// pick something that fits", and they all end in the same validated shape.

import { BPS_TOTAL, MAX_MARKETS, MIN_MARKETS } from './abi.js';

/**
 * Keyword themes per ticker. Deliberately hand-written and short: the value is
 * in the obvious associations a person would make, not in coverage. A coin
 * that matches nothing falls through to the fallback strategy rather than
 * being forced into a weak match.
 */
export const MARKET_THEMES = Object.freeze({
	TSLA: ['tesla', 'elon', 'musk', 'cybertruck', 'robotaxi', 'electric vehicle'],
	NVDA: ['nvidia', 'gpu', 'cuda', 'jensen', 'inference', 'agi', 'ai', 'llm'],
	AAPL: ['apple', 'iphone', 'macbook', 'ios', 'siri', 'vision pro', 'tim cook'],
	MSFT: ['microsoft', 'windows', 'azure', 'copilot', 'xbox', 'openai'],
	GOOGL: ['google', 'alphabet', 'gemini', 'youtube', 'android', 'chrome'],
	AMZN: ['amazon', 'bezos', 'aws', 'prime day'],
	META: ['meta', 'facebook', 'instagram', 'zuck', 'zuckerberg', 'metaverse', 'whatsapp', 'llama'],
	COIN: ['coinbase', 'brian armstrong'],
	CRCL: ['circle', 'usdc', 'stablecoin'],
	PLTR: ['palantir', 'gotham', 'alex karp', 'surveillance'],
	AMD: ['amd', 'ryzen', 'radeon', 'lisa su'],
	INTC: ['x86', 'foundry', 'semiconductor'],
	MU: ['micron', 'dram', 'hbm'],
	SNDK: ['sandisk', 'ssd'],
	ORCL: ['oracle', 'larry ellison'],
	BABA: ['alibaba', 'jack ma', 'taobao', 'singles day'],
	SPCX: ['spacex', 'starship', 'falcon 9', 'mars', 'rocket', 'astronaut', 'orbit'],
	CRWV: ['coreweave', 'datacenter', 'gpu cloud'],
	BE: ['bloom energy', 'fuel cell', 'hydrogen'],
	USAR: ['rare earth', 'critical minerals'],
	SLV: ['silver', 'bullion'],
	SGOV: ['treasury bill', 't-bill', 'risk free'],
	SPY: ['sp500', 's&p', 'stonks'],
	QQQ: ['nasdaq'],
});

/**
 * Minimum score a themed market needs before it beats the fallback. A single
 * keyword buried in a description is a coincidence, not a theme: at 4, a market
 * must be named in the coin's name or ticker, or referenced repeatedly in its
 * description, to win a pool.
 */
export const MIN_THEME_SCORE = 4;

/** Markets used when nothing else selects one. The deepest, most-launched pools. */
export const FALLBACK_MARKETS = Object.freeze(['NVDA', 'TSLA', 'AAPL']);

/**
 * Split 10000 bps across `n` pools as evenly as the integer allows, giving the
 * remainder to the first pools. Three markets become 3334/3333/3333, which
 * sums to exactly 10000: the contract rejects anything else.
 *
 * @param {number} n
 * @returns {number[]}
 */
export function evenWeights(n) {
	if (n < 1) throw new Error('need at least one market');
	const base = Math.floor(BPS_TOTAL / n);
	const weights = Array.from({ length: n }, () => base);
	let remainder = BPS_TOTAL - base * n;
	for (let i = 0; remainder > 0; i = (i + 1) % n, remainder--) weights[i] += 1;
	return weights;
}

/**
 * Score how well each market matches a coin's text. A ticker mentioned by name
 * outranks a themed keyword, and a keyword appearing in the name outranks the
 * same keyword in the description, because a name is the coin's claim about
 * itself and a description is commentary.
 *
 * @param {{name?: string, symbol?: string, description?: string}} spec
 * @param {Record<string, string[]>} [themes]
 * @returns {{symbol: string, score: number, matched: string[]}[]} Scored, best first, zero-score entries dropped.
 */
export function scoreMarkets(spec, themes = MARKET_THEMES) {
	const name = `${String(spec.name || '')} ${String(spec.symbol || '')}`.toLowerCase();
	const body = String(spec.description || '').toLowerCase();
	const out = [];
	for (const [ticker, keywords] of Object.entries(themes)) {
		let score = 0;
		const matched = [];
		if (wordMatcher(ticker).test(name)) { score += 6; matched.push(ticker); }
		for (const kw of keywords) {
			const re = wordMatcher(kw);
			if (re.test(name)) { score += 4; matched.push(kw); }
			else if (re.test(body)) { score += 1; matched.push(kw); }
		}
		if (score > 0) out.push({ symbol: ticker, score, matched });
	}
	return out.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

// Whole-word matching, cached per keyword. Substring matching pairs a cartoon
// seagull with TSLA because "cartoon" contains "car", and a launch decision
// that silly is worse than no theme at all.
const _matchers = new Map();
function wordMatcher(keyword) {
	const key = keyword.toLowerCase();
	let re = _matchers.get(key);
	if (!re) {
		re = new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
		_matchers.set(key, re);
	}
	return re;
}

/**
 * @typedef {object} MarketSelection
 * @property {{symbol: string, address: string, weightBps: number, decimals: number}[]} markets
 * @property {string} strategy
 * @property {string} rationale  One line explaining the pick, shown in the launch plan.
 */

/**
 * @param {object} opts
 * @param {'thematic'|'fixed'|'least-crowded'|'popular'|'random'} [opts.strategy]
 * @param {string[]} [opts.markets]          Tickers, for the 'fixed' strategy.
 * @param {number[]} [opts.weights]          Basis points, for 'fixed'. Defaults to an even split.
 * @param {number} [opts.count]              Maximum markets a non-fixed strategy picks. Default 2.
 * @param {string[]} [opts.fallback]         Tickers used when a strategy selects nothing.
 * @param {number} [opts.minThemeScore]      Score a themed match must clear. Default 4.
 * @param {Record<string, string[]>} [opts.themes] Ticker to keyword map. Defaults to MARKET_THEMES.
 * @param {() => number} [opts.random]
 */
export function createMarketSelector(opts = {}) {
	const {
		strategy = 'thematic', markets: fixed = [], weights: fixedWeights,
		count = 2, fallback = FALLBACK_MARKETS, random = Math.random,
		minThemeScore = MIN_THEME_SCORE, themes = MARKET_THEMES,
	} = opts;

	/**
	 * @param {import('../../types.js').LaunchSpec} spec
	 * @param {object[]} stockTokens  Live /api/stock-tokens response.
	 * @returns {MarketSelection}
	 */
	function select(spec, stockTokens) {
		const enabled = stockTokens.filter((t) => t?.enabled && t?.address && t?.symbol);
		if (!enabled.length) throw new Error('PAIR reports no enabled stock markets');
		const bySymbol = new Map(enabled.map((t) => [String(t.symbol).toUpperCase(), t]));

		const hinted = spec?.targetHints?.markets;
		if (Array.isArray(hinted) && hinted.length) {
			return finish(hinted.map((h) => (typeof h === 'string' ? { symbol: h } : h)), 'hint', 'markets supplied by the mapper hint');
		}

		switch (strategy) {
			case 'fixed': {
				if (!fixed.length) throw new Error("market strategy 'fixed' needs a markets list");
				const picks = fixed.map((symbol, i) => ({ symbol, weightBps: fixedWeights?.[i] }));
				return finish(picks, 'fixed', `configured markets ${fixed.join(', ')}`);
			}
			case 'least-crowded': {
				const sorted = [...enabled].sort(
					(a, b) => (a.launchedTokenCount ?? 0) - (b.launchedTokenCount ?? 0) || a.symbol.localeCompare(b.symbol),
				);
				const picks = sorted.slice(0, clampCount(count));
				return finish(picks, 'least-crowded', `fewest existing launches: ${picks.map((p) => `${p.symbol} (${p.launchedTokenCount ?? 0})`).join(', ')}`);
			}
			case 'popular': {
				const sorted = [...enabled].sort(
					(a, b) => (b.launchedTokenCount ?? 0) - (a.launchedTokenCount ?? 0) || a.symbol.localeCompare(b.symbol),
				);
				const picks = sorted.slice(0, clampCount(count));
				return finish(picks, 'popular', `most-launched markets: ${picks.map((p) => `${p.symbol} (${p.launchedTokenCount ?? 0})`).join(', ')}`);
			}
			case 'random': {
				const pool = [...enabled];
				const picks = [];
				const n = clampCount(count);
				while (picks.length < n && pool.length) picks.push(...pool.splice(Math.floor(random() * pool.length), 1));
				return finish(picks, 'random', `random markets ${picks.map((p) => p.symbol).join(', ')}`);
			}
			case 'thematic':
			default: {
				const scored = scoreMarkets(spec, themes)
					.filter((s) => bySymbol.has(s.symbol) && s.score >= minThemeScore);
				if (!scored.length) {
					const picks = fallback.filter((s) => bySymbol.has(s.toUpperCase())).slice(0, clampCount(count));
					return finish(
						picks.map((symbol) => ({ symbol })),
						'thematic',
						'no theme matched the coin text, using the fallback markets',
					);
				}
				const picks = scored.slice(0, clampCount(count));
				const why = picks.map((p) => `${p.symbol} (${p.matched.slice(0, 3).join('/')})`).join(', ');
				return finish(picks, 'thematic', `matched ${why}`);
			}
		}

		function finish(picks, usedStrategy, rationale) {
			const resolved = [];
			const seen = new Set();
			for (const pick of picks) {
				const key = String(pick.symbol || '').toUpperCase();
				const token = bySymbol.get(key);
				if (!token || seen.has(key)) continue;
				seen.add(key);
				resolved.push({
					symbol: token.symbol,
					address: token.address,
					decimals: token.decimals ?? 18,
					weightBps: pick.weightBps,
				});
			}
			if (!resolved.length) {
				throw new Error(
					`market strategy '${usedStrategy}' selected no enabled market (wanted ${picks.map((p) => p.symbol).join(', ') || 'nothing'})`,
				);
			}
			const trimmed = resolved.slice(0, MAX_MARKETS);
			const explicit = trimmed.every((m) => Number.isInteger(m.weightBps));
			const weights = explicit ? trimmed.map((m) => m.weightBps) : evenWeights(trimmed.length);
			const sum = weights.reduce((a, b) => a + b, 0);
			if (sum !== BPS_TOTAL) {
				throw new Error(`market weights must total ${BPS_TOTAL} bps, got ${sum}`);
			}
			return {
				strategy: usedStrategy,
				rationale,
				markets: trimmed.map((m, i) => ({ ...m, weightBps: weights[i] })),
			};
		}
	}

	return { select, strategy };
}

const clampCount = (n) => Math.max(MIN_MARKETS, Math.min(MAX_MARKETS, Number(n) || 1));
