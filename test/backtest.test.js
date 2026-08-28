import { describe, expect, it } from 'vitest';
import { UNBACKTESTABLE_RULES, backtest, toHistoricalSignal } from '../src/backtest.js';

const coin = (over = {}) => ({
	mint: 'MINT1',
	name: 'Test Coin',
	symbol: 'TEST',
	description: 'a coin',
	image_uri: 'https://ipfs.io/ipfs/x',
	creator: 'CREATOR',
	created_timestamp: 1_787_800_000_000,
	usd_market_cap: 61_000,
	ath_market_cap: 240_000,
	reply_count: 14,
	complete: true,
	...over,
});

describe('toHistoricalSignal', () => {
	it('moves every forward-looking number out of the rules path', () => {
		const signal = toHistoricalSignal(coin());
		expect(signal.metrics.marketCapUsd).toBeNull();
		expect(signal.metrics.athMarketCapUsd).toBeNull();
		expect(signal.metrics.replyCount).toBeNull();
		expect(signal.outcome.athMarketCapUsd).toBe(240_000);
		expect(signal.outcome.marketCapUsd).toBe(61_000);
	});

	it('keeps what was genuinely knowable at graduation', () => {
		const signal = toHistoricalSignal(coin());
		expect(signal.name).toBe('Test Coin');
		expect(signal.symbol).toBe('TEST');
		expect(signal.imageUrl).toBe('https://ipfs.io/ipfs/x');
		expect(signal.creator).toBe('CREATOR');
	});

	it('orders on coin creation rather than the moment it was fetched', () => {
		expect(toHistoricalSignal(coin()).at).toBe(1_787_800_000_000);
	});

	it('marks the signal historical', () => {
		expect(toHistoricalSignal(coin()).historical).toBe(true);
	});

	it('returns null without a mint', () => {
		expect(toHistoricalSignal({ name: 'x' })).toBeNull();
	});
});

describe('backtest', () => {
	const signals = (n, make = () => ({})) => Array.from({ length: n }, (_, i) => toHistoricalSignal(coin({
		mint: `MINT${i}`,
		symbol: `T${i}`,
		created_timestamp: 1_787_800_000_000 + i * 3_600_000,
		ath_market_cap: 10_000 * (i + 1),
		...make(i),
	})));

	const noBudget = {
		maxLaunchesPerHour: null, maxLaunchesPerDay: null, maxLaunchesPerWalletPerDay: null,
		cooldownMs: 0, walletCooldownMs: 0, maxSpendPerLaunch: null, maxSpendPerDay: null,
	};

	it('switches off rules the historical record cannot answer, and says which', async () => {
		const report = await backtest({
			signals: signals(5),
			rules: { minMarketCapUsd: 40_000, maxSignalAgeSeconds: 300, requireImage: true },
			budget: noBudget,
		});
		expect(report.untestedRules).toEqual(['minMarketCapUsd', 'maxSignalAgeSeconds']);
		expect(report.passed).toBe(5);
	});

	it('lists every unbacktestable key it knows about', () => {
		expect(UNBACKTESTABLE_RULES).toContain('minMarketCapUsd');
		expect(UNBACKTESTABLE_RULES).toContain('maxCreatorLaunches');
	});

	it('still applies rules that only need what was knowable', async () => {
		const report = await backtest({
			signals: signals(6, (i) => (i < 2 ? { name: 'obvious rug' } : {})),
			rules: { denyWords: ['rug'] },
			budget: noBudget,
		});
		expect(report.passed).toBe(4);
		expect(report.rejected).toBe(2);
		expect(report.rejectionReasons[0].count).toBe(2);
	});

	it('replays the budget chronologically so cooldowns land where they would live', async () => {
		const report = await backtest({
			signals: signals(6),
			budget: { ...noBudget, cooldownMs: 7_200_000 },
		});
		// Signals are an hour apart and the cooldown is two hours, so roughly
		// every other one survives instead of all of them or just the first.
		expect(report.launched).toBeGreaterThan(1);
		expect(report.launched).toBeLessThan(6);
		expect(report.throttled).toBe(report.passed - report.launched);
	});

	it('scores cohorts on the outcome field, not on anything a rule could see', async () => {
		const report = await backtest({
			signals: signals(10, (i) => (i < 5 ? { name: 'rug time' } : {})),
			rules: { denyWords: ['rug'] },
			budget: noBudget,
		});
		expect(report.selection.selected.count).toBe(5);
		expect(report.selection.rejected.count).toBe(5);
		expect(report.selection.selected.median).toBeGreaterThan(report.selection.rejected.median);
	});

	it('prices the run at the supplied per-launch cost', async () => {
		const report = await backtest({
			signals: signals(3), budget: noBudget, costPerLaunch: 1_000_000n,
		});
		expect(report.cost.totalBase).toBe(3_000_000n);
	});

	it('reports a real time window', async () => {
		const report = await backtest({ signals: signals(4), budget: noBudget });
		expect(report.window.hours).toBe(3);
	});

	it('handles an empty input without dividing by zero', async () => {
		const report = await backtest({ signals: [], budget: noBudget });
		expect(report.scanned).toBe(0);
		expect(report.passRate).toBe(0);
		expect(report.selection.medianLift).toBeNull();
	});
});
