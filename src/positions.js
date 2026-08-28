// Portfolio.
//
// A launcher that only launches is half a tool. Once a token exists it has a
// market cap, depth, a graduation milestone, and a fee stream, and the operator
// needs one place that answers: what did I spend, what do I own, and what has
// it paid me back.
//
// The ledger is the source of truth for spend, because it recorded what
// actually left the wallets. Everything else is read live from the launchpad,
// because a cached market cap is a wrong market cap.

import { formatUnits } from 'viem';

/**
 * @typedef {object} Position
 * @property {string} symbol
 * @property {string} tokenAddress
 * @property {string} wallet
 * @property {number} launchedAt
 * @property {string} costNative
 * @property {bigint} costBase
 * @property {number|null} marketCapUsd
 * @property {number|null} priceUsd
 * @property {number|null} liquidityUsd
 * @property {number|null} volume24hUsd
 * @property {boolean} graduated
 * @property {number|null} graduationProgress
 * @property {string[]} pairedWith
 * @property {string} url
 * @property {string|null} origin
 */

/**
 * Build the portfolio from the ledger plus live launchpad state.
 *
 * Tokens the launchpad no longer knows about are kept, not dropped: a launch
 * that cost money and then vanished from an index is the single most important
 * row in the report, and hiding it would be the one bug that matters here.
 *
 * @param {object} opts
 * @param {import('./types.js').Store} opts.store
 * @param {object} opts.api             PAIR API client.
 * @param {number} [opts.decimals]
 * @param {string} [opts.nativeSymbol]
 * @returns {Promise<{positions: Position[], totals: object}>}
 */
export async function buildPortfolio({ store, api, decimals = 18, nativeSymbol = 'ETH' }) {
	const records = (await store.history({ since: 0 })).filter((r) => r.status === 'launched' && r.tokenAddress);

	const positions = [];
	for (const record of records) {
		let live = null;
		try {
			live = await api.token(record.tokenAddress);
		} catch {
			live = null;
		}
		positions.push({
			symbol: record.symbol || live?.symbol || '?',
			name: record.name || live?.name || null,
			tokenAddress: record.tokenAddress,
			wallet: record.wallet,
			launchedAt: record.at,
			costNative: record.costNative || formatUnits(toBase(record.costBase), decimals),
			costBase: toBase(record.costBase),
			txHash: record.txHash || null,
			marketCapUsd: numOrNull(live?.marketCapUsd),
			priceUsd: numOrNull(live?.priceUsd),
			liquidityUsd: numOrNull(live?.totalDepthUsd),
			volume24hUsd: numOrNull(live?.volume24hUsd),
			holders: numOrNull(live?.holders),
			graduated: Boolean(live?.graduated),
			graduationProgress: numOrNull(live?.combinedGraduationProgress),
			pairedWith: (live?.pairs || []).map((p) => p?.quoteToken?.symbol).filter(Boolean),
			indexed: Boolean(live),
			url: `${api.baseUrl}/tokens/${record.tokenAddress}`,
			origin: record.origin?.address || null,
			originUrl: record.origin?.url || null,
		});
	}

	const spentBase = positions.reduce((sum, p) => sum + p.costBase, 0n);
	return {
		positions: positions.sort((a, b) => b.launchedAt - a.launchedAt),
		totals: {
			count: positions.length,
			spentBase,
			spentNative: trimZeros(formatUnits(spentBase, decimals)),
			nativeSymbol,
			marketCapUsd: sumOrNull(positions.map((p) => p.marketCapUsd)),
			liquidityUsd: sumOrNull(positions.map((p) => p.liquidityUsd)),
			graduated: positions.filter((p) => p.graduated).length,
			unindexed: positions.filter((p) => !p.indexed).length,
			wallets: new Set(positions.map((p) => String(p.wallet).toLowerCase())).size,
		},
	};
}

/**
 * Spend against realized and unrealized fee revenue.
 *
 * Fees accrue in whatever asset the pool charges, so there is no single
 * currency to net against ETH spend. Rather than invent a conversion, this
 * reports the two sides side by side and converts only where PAIR itself
 * supplied a USD figure.
 *
 * @param {object} opts
 * @param {object} opts.portfolio      From buildPortfolio.
 * @param {object[]} opts.claimable    From fees.fetchClaimable.
 * @param {object[]} opts.pending      From fees.fetchPending.
 * @param {object[]} [opts.history]    From api.feesHistory.
 */
export function summarizeEconomics({ portfolio, claimable = [], pending = [], history = [] }) {
	const claimableUsd = sumOrNull(claimable.map((c) => c.amountUsd));
	const pendingUsd = sumOrNull(pending.map((p) => p.amountUsd));
	const claimedRows = Array.isArray(history) ? history : history?.items || [];

	return {
		spentNative: portfolio.totals.spentNative,
		nativeSymbol: portfolio.totals.nativeSymbol,
		launches: portfolio.totals.count,
		claimable: claimable.map((c) => ({ symbol: c.symbol, amount: c.amountFormatted, usd: c.amountUsd })),
		claimableUsd,
		pendingCount: pending.length,
		pendingUsd,
		claimsMade: claimedRows.length,
		// Deliberately not a single "profit" number. Fees arrive in stock tokens
		// and project tokens whose USD value PAIR does not always price, and a
		// made-up conversion would be the most quoted and least true line here.
		note: 'Fees accrue in the pool asset, not ETH. USD figures appear only where PAIR priced them.',
	};
}

const toBase = (v) => {
	if (typeof v === 'bigint') return v;
	const s = String(v ?? '0');
	return /^\d+$/.test(s) ? BigInt(s) : 0n;
};
const numOrNull = (v) => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const sumOrNull = (list) => {
	const nums = list.filter((n) => typeof n === 'number' && Number.isFinite(n));
	return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
};
const trimZeros = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
