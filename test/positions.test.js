import { describe, expect, it } from 'vitest';
import { buildPortfolio, summarizeEconomics } from '../src/positions.js';
import { createMemoryStore } from '../src/store/memory.js';

const api = (tokens = {}) => ({
	baseUrl: 'https://pair.fund',
	token: async (address) => {
		const t = tokens[address];
		if (!t) throw new Error('404');
		return t;
	},
});

async function storeWith(records) {
	const store = createMemoryStore();
	for (const r of records) await store.record(r);
	return store;
}

describe('buildPortfolio', () => {
	it('joins ledger spend with live launchpad state', async () => {
		const store = await storeWith([{
			status: 'launched', symbol: 'AAA', tokenAddress: '0xaaa', wallet: '0x1',
			costBase: '650000000000000', costNative: '0.00065', at: 1_000,
		}]);
		const portfolio = await buildPortfolio({
			store,
			api: api({
				'0xaaa': {
					symbol: 'AAA', marketCapUsd: '12000', totalDepthUsd: '900', graduated: false,
					combinedGraduationProgress: 12, pairs: [{ quoteToken: { symbol: 'NVDA' } }],
				},
			}),
		});
		expect(portfolio.positions).toHaveLength(1);
		expect(portfolio.positions[0]).toMatchObject({
			symbol: 'AAA', marketCapUsd: 12_000, liquidityUsd: 900, pairedWith: ['NVDA'], indexed: true,
		});
		expect(portfolio.totals.spentNative).toBe('0.00065');
	});

	it('keeps a launch the launchpad no longer indexes', async () => {
		const store = await storeWith([{
			status: 'launched', symbol: 'GONE', tokenAddress: '0xgone', wallet: '0x1', costBase: '1', at: 1,
		}]);
		const portfolio = await buildPortfolio({ store, api: api({}) });
		expect(portfolio.positions).toHaveLength(1);
		expect(portfolio.positions[0].indexed).toBe(false);
		expect(portfolio.totals.unindexed).toBe(1);
	});

	it('ignores planned and declined records', async () => {
		const store = await storeWith([
			{ status: 'planned', symbol: 'P', tokenAddress: '0xp', at: 1 },
			{ status: 'declined', symbol: 'D', tokenAddress: '0xd', at: 2 },
		]);
		const portfolio = await buildPortfolio({ store, api: api({}) });
		expect(portfolio.positions).toHaveLength(0);
	});

	it('sums spend across wallets and counts distinct ones', async () => {
		const store = await storeWith([
			{ status: 'launched', symbol: 'A', tokenAddress: '0xa', wallet: '0xAA', costBase: '100', at: 1 },
			{ status: 'launched', symbol: 'B', tokenAddress: '0xb', wallet: '0xaa', costBase: '200', at: 2 },
			{ status: 'launched', symbol: 'C', tokenAddress: '0xc', wallet: '0xbb', costBase: '300', at: 3 },
		]);
		const portfolio = await buildPortfolio({ store, api: api({}) });
		expect(portfolio.totals.spentBase).toBe(600n);
		expect(portfolio.totals.wallets).toBe(2);
	});

	it('orders newest first', async () => {
		const store = await storeWith([
			{ status: 'launched', symbol: 'OLD', tokenAddress: '0x1', at: 1 },
			{ status: 'launched', symbol: 'NEW', tokenAddress: '0x2', at: 9 },
		]);
		const portfolio = await buildPortfolio({ store, api: api({}) });
		expect(portfolio.positions.map((p) => p.symbol)).toEqual(['NEW', 'OLD']);
	});

	it('leaves unreadable market data null rather than zero', async () => {
		const store = await storeWith([{ status: 'launched', symbol: 'A', tokenAddress: '0xa', at: 1 }]);
		const portfolio = await buildPortfolio({ store, api: api({ '0xa': { symbol: 'A' } }) });
		expect(portfolio.positions[0].marketCapUsd).toBeNull();
		expect(portfolio.totals.marketCapUsd).toBeNull();
	});
});

describe('summarizeEconomics', () => {
	it('reports fees beside spend without inventing a conversion', () => {
		const economics = summarizeEconomics({
			portfolio: { totals: { spentNative: '0.002', nativeSymbol: 'ETH', count: 3 } },
			claimable: [{ symbol: 'DOGE', amountFormatted: '2107.49', amountUsd: null }],
			pending: [{ symbol: 'AAPL' }],
			history: [{ txHash: '0x1' }],
		});
		expect(economics.spentNative).toBe('0.002');
		expect(economics.claimable[0]).toMatchObject({ symbol: 'DOGE', amount: '2107.49' });
		expect(economics.claimableUsd).toBeNull();
		expect(economics.pendingCount).toBe(1);
		expect(economics.claimsMade).toBe(1);
		expect(economics.note).toMatch(/not ETH/);
	});

	it('sums USD only where it was actually priced', () => {
		const economics = summarizeEconomics({
			portfolio: { totals: { spentNative: '0', nativeSymbol: 'ETH', count: 0 } },
			claimable: [{ symbol: 'A', amountUsd: 10 }, { symbol: 'B', amountUsd: null }],
		});
		expect(economics.claimableUsd).toBe(10);
	});
});
