import { describe, expect, it } from 'vitest';
import { pct, renderBacktest, renderFees, renderPlan, renderPositions, usd } from '../src/report.js';

describe('usd', () => {
	it('distinguishes unknown from zero', () => {
		expect(usd(null)).toBe('-');
		expect(usd(0)).toBe('$0.0');
	});

	it('scales large numbers', () => {
		expect(usd(2_140_000)).toBe('$2.14M');
		expect(usd(41_900)).toBe('$41,900');
	});
});

describe('pct', () => {
	it('accepts a fraction or a percentage', () => {
		expect(pct(0.072)).toBe('7.2%');
		expect(pct(12)).toBe('12.0%');
		expect(pct(null)).toBe('-');
	});
});

describe('renderPlan', () => {
	it('shows the summary and any warnings', () => {
		const text = renderPlan({ summary: ['total 0.0008 ETH'], warnings: ['image missing'] });
		expect(text).toContain('LAUNCH PLAN');
		expect(text).toContain('total 0.0008 ETH');
		expect(text).toContain('warning     image missing');
	});
});

const report = (over = {}) => ({
	untestedRules: ['minMarketCapUsd'],
	window: { from: 1_787_800_000_000, to: 1_787_820_000_000, hours: 5.5 },
	scanned: 300, passed: 60, rejected: 240, launched: 10, throttled: 50, passRate: 0.2,
	rejectionReasons: [{ reason: 'no image', count: 120 }],
	cost: { perLaunchBase: 650_000_000_000_000n, totalBase: 6_500_000_000_000_000n, nativeSymbol: 'ETH', decimals: 18 },
	selection: {
		selected: { count: 10, median: 118_400, p75: 245_000, best: 2_140_000 },
		rejected: { count: 240, median: 41_900, p75: 78_000, best: 1_020_000 },
		medianLift: 2.826,
	},
	pairing: [{ symbol: 'NVDA', count: 6, themed: 2 }],
	plans: [], throttledSamples: [], best: [], missed: [],
	...over,
});

describe('renderBacktest', () => {
	it('names the rules it could not test before reporting the result', () => {
		const text = renderBacktest(report());
		expect(text.indexOf('minMarketCapUsd')).toBeLessThan(text.indexOf('SELECTION QUALITY'));
	});

	it('states plainly that this is not a return', () => {
		expect(renderBacktest(report())).toContain('It is not a');
	});

	it('flags a small sample on either side of the comparison', () => {
		const thin = renderBacktest(report({
			selection: {
				selected: { count: 3, median: 100, p75: 100, best: 100 },
				rejected: { count: 240, median: 50, p75: 50, best: 50 },
				medianLift: 2,
			},
		}));
		expect(thin).toContain('SMALL SAMPLE');
	});

	it('omits the small-sample warning when both cohorts are large', () => {
		expect(renderBacktest(report())).not.toContain('SMALL SAMPLE');
	});
});

describe('renderPositions', () => {
	it('renders a portfolio with totals', () => {
		const text = renderPositions({
			positions: [{
				symbol: 'AAA', marketCapUsd: 12_000, liquidityUsd: 900, costNative: '0.00065',
				pairedWith: ['NVDA'], graduated: false, indexed: true, graduationProgress: 12,
			}],
			totals: { count: 1, wallets: 1, spentNative: '0.00065', nativeSymbol: 'ETH', marketCapUsd: 12_000, liquidityUsd: 900, unindexed: 0 },
		});
		expect(text).toContain('AAA');
		expect(text).toContain('$12,000');
		expect(text).toContain('total');
	});

	it('calls out tokens the launchpad no longer indexes', () => {
		const text = renderPositions({
			positions: [{ symbol: 'GONE', costNative: '0.001', pairedWith: [], indexed: false, marketCapUsd: null, liquidityUsd: null }],
			totals: { count: 1, wallets: 1, spentNative: '0.001', nativeSymbol: 'ETH', unindexed: 1, marketCapUsd: null, liquidityUsd: null },
		});
		expect(text).toContain('not indexed');
		expect(text).toContain('no longer indexes');
	});
});

describe('renderFees', () => {
	it('says so when there is nothing', () => {
		expect(renderFees([], [])).toBe('no fees claimable or pending');
	});

	it('separates claimable from pending', () => {
		const text = renderFees(
			[{ amountFormatted: '2107.49', symbol: 'DOGE', assetType: 'PROJECT', lockerAddress: '0xlock' }],
			[{ amount: 5n, symbol: 'AAPL' }],
		);
		expect(text).toContain('CLAIMABLE NOW');
		expect(text).toContain('PENDING');
		expect(text).toContain('project token');
	});
});
