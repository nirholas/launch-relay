import { describe, expect, it } from 'vitest';
import { BPS_TOTAL } from '../src/targets/pairfund/abi.js';
import { createMarketSelector, evenWeights, scoreMarkets } from '../src/targets/pairfund/markets.js';

const STOCKS = [
	{ symbol: 'NVDA', address: '0xnvda', decimals: 18, enabled: true, launchedTokenCount: 17 },
	{ symbol: 'TSLA', address: '0xtsla', decimals: 18, enabled: true, launchedTokenCount: 10 },
	{ symbol: 'AAPL', address: '0xaapl', decimals: 18, enabled: true, launchedTokenCount: 30 },
	{ symbol: 'ORCL', address: '0xorcl', decimals: 18, enabled: true, launchedTokenCount: 0 },
	{ symbol: 'BE', address: '0xbe', decimals: 18, enabled: false, launchedTokenCount: 0 },
];

const spec = (over = {}) => ({ name: 'Coin', symbol: 'COIN', description: '', targetHints: {}, ...over });

describe('evenWeights', () => {
	it('always totals exactly 10000 basis points', () => {
		for (let n = 1; n <= 5; n++) {
			expect(evenWeights(n).reduce((a, b) => a + b, 0)).toBe(BPS_TOTAL);
		}
	});

	it('gives the remainder to the first pools', () => {
		expect(evenWeights(3)).toEqual([3334, 3333, 3333]);
	});
});

describe('scoreMarkets', () => {
	it('matches whole words only', () => {
		expect(scoreMarkets({ name: 'Poppy', description: 'a cartoon seagull' })).toEqual([]);
	});

	it('ranks a name match above a description mention', () => {
		const scored = scoreMarkets({ name: 'Tesla Bot', symbol: 'BOT', description: 'nvidia is mentioned once' });
		expect(scored[0].symbol).toBe('TSLA');
	});

	it('scores an explicit ticker highest', () => {
		const scored = scoreMarkets({ name: 'NVDA maxi', symbol: 'MAXI', description: '' });
		expect(scored[0].symbol).toBe('NVDA');
	});
});

describe('createMarketSelector', () => {
	it('uses the fallback when nothing clears the theme threshold', () => {
		const out = createMarketSelector({ strategy: 'thematic', count: 2 }).select(spec(), STOCKS);
		expect(out.markets.map((m) => m.symbol)).toEqual(['NVDA', 'TSLA']);
		expect(out.rationale).toMatch(/no theme matched/);
	});

	it('pairs a themed coin with its market', () => {
		const out = createMarketSelector({ strategy: 'thematic' })
			.select(spec({ name: 'Cybertruck Guy', description: 'elon musk' }), STOCKS);
		expect(out.markets[0].symbol).toBe('TSLA');
		expect(out.markets[0].weightBps).toBe(BPS_TOTAL);
	});

	it('never selects a disabled market', () => {
		const out = createMarketSelector({ strategy: 'least-crowded', count: 5 }).select(spec(), STOCKS);
		expect(out.markets.map((m) => m.symbol)).not.toContain('BE');
	});

	it('orders least-crowded by existing launch count', () => {
		const out = createMarketSelector({ strategy: 'least-crowded', count: 2 }).select(spec(), STOCKS);
		expect(out.markets.map((m) => m.symbol)).toEqual(['ORCL', 'TSLA']);
	});

	it('orders popular by existing launch count', () => {
		const out = createMarketSelector({ strategy: 'popular', count: 2 }).select(spec(), STOCKS);
		expect(out.markets.map((m) => m.symbol)).toEqual(['AAPL', 'NVDA']);
	});

	it('honours fixed markets and explicit weights', () => {
		const out = createMarketSelector({ strategy: 'fixed', markets: ['AAPL', 'NVDA'], weights: [7000, 3000] })
			.select(spec(), STOCKS);
		expect(out.markets.map((m) => [m.symbol, m.weightBps])).toEqual([['AAPL', 7000], ['NVDA', 3000]]);
	});

	it('rejects explicit weights that do not total 10000', () => {
		const selector = createMarketSelector({ strategy: 'fixed', markets: ['AAPL', 'NVDA'], weights: [7000, 2000] });
		expect(() => selector.select(spec(), STOCKS)).toThrow(/must total 10000/);
	});

	it('lets a mapper hint override the strategy', () => {
		const out = createMarketSelector({ strategy: 'thematic' })
			.select(spec({ targetHints: { markets: ['AAPL'] } }), STOCKS);
		expect(out.strategy).toBe('hint');
		expect(out.markets[0].symbol).toBe('AAPL');
	});

	it('caps the selection at five markets', () => {
		const many = Array.from({ length: 8 }, (_, i) => ({
			symbol: `T${i}`, address: `0x${i}`, decimals: 18, enabled: true, launchedTokenCount: i,
		}));
		const out = createMarketSelector({ strategy: 'least-crowded', count: 8 }).select(spec(), many);
		expect(out.markets).toHaveLength(5);
		expect(out.markets.reduce((sum, m) => sum + m.weightBps, 0)).toBe(BPS_TOTAL);
	});

	it('drops duplicate tickers before weighting', () => {
		const out = createMarketSelector({ strategy: 'fixed', markets: ['AAPL', 'AAPL', 'NVDA'] }).select(spec(), STOCKS);
		expect(out.markets.map((m) => m.symbol)).toEqual(['AAPL', 'NVDA']);
		expect(out.markets.reduce((sum, m) => sum + m.weightBps, 0)).toBe(BPS_TOTAL);
	});

	it('refuses when a fixed market is not listed', () => {
		const selector = createMarketSelector({ strategy: 'fixed', markets: ['GME'] });
		expect(() => selector.select(spec(), STOCKS)).toThrow(/selected no enabled market/);
	});
});
