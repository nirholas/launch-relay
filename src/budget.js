// Spend and rate guards.
//
// An autonomous launcher is a program with a private key and a loop, so the
// interesting question is not "can it launch" but "what stops it". These are
// the stops. They run after a plan is priced and before anything is signed,
// and each one answers with a reason so a halted relay explains itself.
//
// All caps are expressed in whole native units as decimal strings ('0.05' ETH)
// and compared in base units, because the number a person writes in a config
// file should not be a wei count.

import { formatUnits, parseUnits } from 'viem';
import { existsSync } from 'node:fs';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * @typedef {object} BudgetConfig
 * @property {number} [maxLaunchesPerHour]
 * @property {number} [maxLaunchesPerDay]
 * @property {number} [maxLaunchesPerWalletPerDay]
 * @property {number} [cooldownMs]              Minimum gap between any two launches.
 * @property {number} [walletCooldownMs]        Minimum gap between two launches from one wallet.
 * @property {string} [maxSpendPerLaunch]       Native units, e.g. '0.01'.
 * @property {string} [maxSpendPerDay]          Native units.
 * @property {string} [minWalletReserve]        Native units left untouched in every wallet.
 * @property {string} [killSwitchFile]          Halt while this path exists.
 */

export const DEFAULT_BUDGET = Object.freeze({
	maxLaunchesPerHour: 6,
	maxLaunchesPerDay: 24,
	maxLaunchesPerWalletPerDay: 6,
	cooldownMs: 30_000,
	walletCooldownMs: 120_000,
	maxSpendPerLaunch: '0.01',
	maxSpendPerDay: '0.1',
	minWalletReserve: '0.001',
});

/**
 * @param {BudgetConfig} [config]
 * @param {{decimals?: number, nativeSymbol?: string}} [chain]
 */
export function createBudget(config = {}, chain = {}) {
	const cfg = { ...DEFAULT_BUDGET, ...config };
	const decimals = chain.decimals ?? 18;
	const symbol = chain.nativeSymbol || 'ETH';
	const cap = (key) => (cfg[key] == null ? null : parseUnits(String(cfg[key]), decimals));

	const maxPerLaunch = cap('maxSpendPerLaunch');
	const maxPerDay = cap('maxSpendPerDay');
	const reserve = cap('minWalletReserve') ?? 0n;

	/**
	 * Everything that must hold before a plan may be signed.
	 *
	 * @param {object} input
	 * @param {bigint} input.costBase       Total native cost of this launch, base units.
	 * @param {string} input.wallet         Address paying.
	 * @param {bigint} input.walletBalance  That wallet's current balance, base units.
	 * @param {object[]} input.history      Prior records from the store (executed launches only matter).
	 * @param {number} [input.now]
	 * @returns {{ok: boolean, reason: string|null, spentTodayBase: bigint}}
	 */
	function check({ costBase, wallet, walletBalance, history = [], now = Date.now() }) {
		const executed = history.filter((r) => r.status === 'launched');
		const lastDay = executed.filter((r) => now - (r.at || 0) < DAY_MS);
		const lastHour = executed.filter((r) => now - (r.at || 0) < HOUR_MS);
		const mine = lastDay.filter((r) => sameAddr(r.wallet, wallet));
		const spentTodayBase = lastDay.reduce((sum, r) => sum + toBase(r.costBase), 0n);

		const deny = (reason) => ({ ok: false, reason, spentTodayBase });

		if (cfg.killSwitchFile && existsSync(cfg.killSwitchFile)) {
			return deny(`kill switch present at ${cfg.killSwitchFile}`);
		}
		if (cfg.maxLaunchesPerHour != null && lastHour.length >= cfg.maxLaunchesPerHour) {
			return deny(`hourly cap reached (${lastHour.length}/${cfg.maxLaunchesPerHour})`);
		}
		if (cfg.maxLaunchesPerDay != null && lastDay.length >= cfg.maxLaunchesPerDay) {
			return deny(`daily cap reached (${lastDay.length}/${cfg.maxLaunchesPerDay})`);
		}
		if (cfg.maxLaunchesPerWalletPerDay != null && mine.length >= cfg.maxLaunchesPerWalletPerDay) {
			return deny(`wallet daily cap reached (${mine.length}/${cfg.maxLaunchesPerWalletPerDay})`);
		}
		if (cfg.cooldownMs) {
			const last = mostRecent(executed);
			if (last != null && now - last < cfg.cooldownMs) {
				return deny(`global cooldown, ${Math.ceil((cfg.cooldownMs - (now - last)) / 1000)}s left`);
			}
		}
		if (cfg.walletCooldownMs) {
			const last = mostRecent(mine);
			if (last != null && now - last < cfg.walletCooldownMs) {
				return deny(`wallet cooldown, ${Math.ceil((cfg.walletCooldownMs - (now - last)) / 1000)}s left`);
			}
		}
		if (maxPerLaunch != null && costBase > maxPerLaunch) {
			return deny(`launch costs ${fmt(costBase)} > per-launch cap ${cfg.maxSpendPerLaunch} ${symbol}`);
		}
		if (maxPerDay != null && spentTodayBase + costBase > maxPerDay) {
			return deny(
				`daily spend would reach ${fmt(spentTodayBase + costBase)} > cap ${cfg.maxSpendPerDay} ${symbol}`,
			);
		}
		if (walletBalance < costBase + reserve) {
			return deny(
				`wallet ${short(wallet)} holds ${fmt(walletBalance)} ${symbol}, needs ${fmt(costBase + reserve)} (cost + ${cfg.minWalletReserve} reserve)`,
			);
		}
		return { ok: true, reason: null, spentTodayBase };
	}

	const fmt = (base) => trimZeros(formatUnits(base, decimals));

	return { check, config: cfg, decimals, nativeSymbol: symbol, reserve, format: fmt };
}

function mostRecent(records) {
	let max = null;
	for (const r of records) if (r.at != null && (max == null || r.at > max)) max = r.at;
	return max;
}

// Ledger records round-trip through JSON, where bigints were stringified.
const toBase = (v) => {
	if (typeof v === 'bigint') return v;
	if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
	return 0n;
};

const sameAddr = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}..${a.slice(-4)}` : a || '?');
const trimZeros = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
