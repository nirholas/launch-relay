import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { createBudget } from '../src/budget.js';

const NOW = 1_700_000_000_000;
const WALLET = '0x1111111111111111111111111111111111111111';

const launched = (over = {}) => ({
	status: 'launched',
	at: NOW - 3_600_000,
	wallet: WALLET,
	costBase: parseEther('0.001').toString(),
	...over,
});

const base = {
	costBase: parseEther('0.001'),
	wallet: WALLET,
	walletBalance: parseEther('1'),
	history: [],
	now: NOW,
};

describe('createBudget', () => {
	it('allows a launch inside every cap', () => {
		const budget = createBudget();
		expect(budget.check(base).ok).toBe(true);
	});

	it('stops at the hourly cap', () => {
		const budget = createBudget({ maxLaunchesPerHour: 2, cooldownMs: 0, walletCooldownMs: 0 });
		const history = [launched({ at: NOW - 60_000 }), launched({ at: NOW - 120_000 })];
		expect(budget.check({ ...base, history })).toMatchObject({ ok: false });
		expect(budget.check({ ...base, history }).reason).toMatch(/hourly cap/);
	});

	it('counts only executed launches, not skipped or planned ones', () => {
		const budget = createBudget({ maxLaunchesPerHour: 1, cooldownMs: 0, walletCooldownMs: 0 });
		const history = [{ status: 'planned', at: NOW - 60_000, wallet: WALLET, costBase: '1' }];
		expect(budget.check({ ...base, history }).ok).toBe(true);
	});

	it('enforces a per-wallet daily cap while the pool still has room', () => {
		const budget = createBudget({
			maxLaunchesPerWalletPerDay: 1, maxLaunchesPerDay: 10, cooldownMs: 0, walletCooldownMs: 0,
		});
		const history = [launched({ at: NOW - 7_200_000 })];
		expect(budget.check({ ...base, history }).reason).toMatch(/wallet daily cap/);
		const other = budget.check({ ...base, wallet: '0x2222222222222222222222222222222222222222', history });
		expect(other.ok).toBe(true);
	});

	it('enforces the global cooldown', () => {
		const budget = createBudget({ cooldownMs: 60_000 });
		const history = [launched({ at: NOW - 10_000 })];
		expect(budget.check({ ...base, history }).reason).toMatch(/global cooldown/);
	});

	it('rejects a launch above the per-launch spend cap', () => {
		const budget = createBudget({ maxSpendPerLaunch: '0.0005' });
		expect(budget.check(base).reason).toMatch(/per-launch cap/);
	});

	it('rejects when the day total would cross the cap', () => {
		const budget = createBudget({
			maxSpendPerDay: '0.0015', cooldownMs: 0, walletCooldownMs: 0, maxLaunchesPerWalletPerDay: 99,
		});
		const history = [launched({ at: NOW - 60_000 })];
		expect(budget.check({ ...base, history }).reason).toMatch(/daily spend/);
	});

	it('reads a stringified cost from a ledger that round-tripped through JSON', () => {
		const budget = createBudget({ maxSpendPerDay: '0.0015', cooldownMs: 0, walletCooldownMs: 0 });
		const history = [launched({ at: NOW - 60_000, costBase: parseEther('0.001').toString() })];
		expect(budget.check({ ...base, history }).spentTodayBase).toBe(parseEther('0.001'));
	});

	it('keeps the wallet reserve untouched', () => {
		const budget = createBudget({ minWalletReserve: '0.01' });
		const check = budget.check({ ...base, walletBalance: parseEther('0.0105') });
		expect(check.ok).toBe(false);
		expect(check.reason).toMatch(/reserve/);
	});

	it('halts entirely while the kill switch file exists', () => {
		const budget = createBudget({ killSwitchFile: 'package.json' });
		expect(budget.check(base).reason).toMatch(/kill switch/);
	});

	it('scales caps to the target chain decimals', () => {
		const budget = createBudget({ maxSpendPerLaunch: '0.5', maxSpendPerDay: '2' }, { decimals: 9, nativeSymbol: 'SOL' });
		expect(budget.check({ ...base, costBase: 600_000_000n }).reason).toMatch(/per-launch cap/);
		expect(budget.check({ ...base, costBase: 400_000_000n }).ok).toBe(true);
	});
});
