// Rendering.
//
// Every number this tool prints is a number someone might act on, so formatting
// lives in one tested place rather than scattered through the CLI. The rule
// throughout: never round away the difference between "zero" and "unknown". A
// dash means we could not read it, and 0 means we read it and it was zero.

import { formatUnits } from 'viem';

const RULE_WIDTH = 68;

export function renderPlan(plan) {
	const lines = ['  LAUNCH PLAN', `  ${'-'.repeat(RULE_WIDTH)}`, ...plan.summary.map((l) => `  ${l}`)];
	if (plan.warnings?.length) {
		lines.push(`  ${'-'.repeat(RULE_WIDTH)}`);
		for (const w of plan.warnings) lines.push(`  warning     ${w}`);
	}
	lines.push(`  ${'-'.repeat(RULE_WIDTH)}`);
	return lines.join('\n');
}

/**
 * The backtest report.
 *
 * Structured so the reader meets the honest caveat before the flattering
 * number: what was scanned, what the rules did, what the caps did, and only
 * then how the selected cohort compared. A selection report that leads with the
 * lift and buries the sample size is a sales document, not a measurement.
 */
export function renderBacktest(report) {
	const out = [];
	const rule = (label) => out.push('', label ? `${label} ${'-'.repeat(Math.max(0, RULE_WIDTH - label.length - 1))}` : '-'.repeat(RULE_WIDTH));

	const from = report.window.from ? new Date(report.window.from).toISOString().replace('T', ' ').slice(0, 16) : '?';
	const to = report.window.to ? new Date(report.window.to).toISOString().replace('T', ' ').slice(0, 16) : '?';
	out.push(`Backtest over ${report.scanned} pump.fun graduations`);
	out.push(`${from} to ${to}  (${report.window.hours}h)`);

	rule('RULES');
	if (report.untestedRules?.length) {
		out.push('  not testable on historical data, so these were switched off:');
		for (const key of report.untestedRules) out.push(`    ${key}`);
		out.push('    pump.fun publishes a coin\'s market cap now and its peak ever,');
		out.push('    both of which are the future relative to the graduation being');
		out.push('    replayed. Feeding either to a rule would select on the answer.');
		out.push('');
	}
	out.push(`  passed        ${String(report.passed).padStart(5)}  (${pct(report.passRate)})`);
	out.push(`  rejected      ${String(report.rejected).padStart(5)}`);
	if (report.rejectionReasons.length) {
		out.push('  why signals were rejected');
		for (const { reason, count } of report.rejectionReasons.slice(0, 6)) {
			out.push(`    ${String(count).padStart(5)}  ${reason}`);
		}
	}

	rule('BUDGET');
	out.push(`  would launch  ${String(report.launched).padStart(5)}  of ${report.passed} that passed the rules`);
	out.push(`  throttled     ${String(report.throttled).padStart(5)}  by caps and cooldowns`);
	out.push(`  cost          ${formatUnits(report.cost.totalBase, report.cost.decimals)} ${report.cost.nativeSymbol}`
		+ `  (${report.launched} x ${formatUnits(report.cost.perLaunchBase, report.cost.decimals)})`);
	for (const t of report.throttledSamples) out.push(`    held back   ${t.symbol}: ${t.reason}`);

	rule('SELECTION QUALITY');
	const s = report.selection.selected;
	const r = report.selection.rejected;
	out.push('  peak market cap reached after graduation');
	out.push(`                    ${'selected'.padStart(14)} ${'rejected'.padStart(14)}`);
	out.push(`    sample          ${String(s.count).padStart(14)} ${String(r.count).padStart(14)}`);
	out.push(`    median          ${usd(s.median).padStart(14)} ${usd(r.median).padStart(14)}`);
	out.push(`    p75             ${usd(s.p75).padStart(14)} ${usd(r.p75).padStart(14)}`);
	out.push(`    best            ${usd(s.best).padStart(14)} ${usd(r.best).padStart(14)}`);
	if (report.selection.medianLift) {
		const lift = report.selection.medianLift;
		out.push('');
		const thin = Math.min(s.count, r.count) < 10;
		out.push(`  the selected cohort's median peak is ${lift.toFixed(2)}x the rejected cohort's`);
		if (thin) {
			out.push(`  SMALL SAMPLE: ${s.count} selected vs ${r.count} rejected. Directional at best.`);
		}
	}
	out.push('');
	out.push('  This measures which SOURCE coins the rules picked. It is not a');
	out.push('  return: the relayed token never existed and its price is unknowable.');

	if (report.pairing.length) {
		rule('MARKET PAIRING');
		for (const p of report.pairing) {
			out.push(`  ${p.symbol.padEnd(8)} ${String(p.count).padStart(4)} launch(es)`
				+ (p.themed ? `  ${p.themed} by theme` : '  all by fallback'));
		}
	}

	if (report.best.length) {
		rule('BIGGEST IT WOULD HAVE CAUGHT');
		for (const b of report.best) {
			out.push(`  ${String(b.symbol || '?').padEnd(12)} ${usd(b.athMarketCapUsd).padStart(14)}  ${b.pairing || ''}`);
		}
	}
	if (report.missed.length) {
		rule('BIGGEST IT FILTERED OUT');
		for (const m of report.missed) {
			out.push(`  ${String(m.symbol || '?').padEnd(12)} ${usd(m.athMarketCapUsd).padStart(14)}`);
		}
	}

	return out.join('\n');
}

export function renderPositions(portfolio, economics) {
	const out = [];
	const t = portfolio.totals;
	out.push(`${t.count} launch(es) from ${t.wallets} wallet(s), ${t.spentNative} ${t.nativeSymbol} spent`);
	if (t.unindexed) out.push(`${t.unindexed} token(s) the launchpad no longer indexes`);
	out.push('');
	out.push(
		`${'symbol'.padEnd(12)} ${'market cap'.padStart(13)} ${'liquidity'.padStart(12)} `
		+ `${'cost'.padStart(12)} ${'pools'.padEnd(14)} status`,
	);
	out.push('-'.repeat(RULE_WIDTH + 20));
	for (const p of portfolio.positions) {
		out.push(
			`${String(p.symbol).padEnd(12)} ${usd(p.marketCapUsd).padStart(13)} ${usd(p.liquidityUsd).padStart(12)} `
			+ `${String(p.costNative).padStart(12)} ${p.pairedWith.join('/').padEnd(14)} `
			+ (p.graduated ? 'graduated' : p.indexed ? `${pct(p.graduationProgress ?? 0)} to milestone` : 'not indexed'),
		);
	}
	if (portfolio.positions.length) {
		out.push('-'.repeat(RULE_WIDTH + 20));
		out.push(`${'total'.padEnd(12)} ${usd(t.marketCapUsd).padStart(13)} ${usd(t.liquidityUsd).padStart(12)} ${String(t.spentNative).padStart(12)}`);
	}

	if (economics) {
		out.push('');
		out.push('FEES');
		if (!economics.claimable.length) out.push('  nothing claimable yet');
		for (const c of economics.claimable) {
			out.push(`  claimable   ${c.amount} ${c.symbol}${c.usd ? ` (${usd(c.usd)})` : ''}`);
		}
		if (economics.pendingCount) out.push(`  pending     ${economics.pendingCount} position(s) awaiting the keeper sweep`);
		if (economics.claimsMade) out.push(`  claimed     ${economics.claimsMade} time(s) historically`);
		out.push(`  ${economics.note}`);
	}

	return out.join('\n');
}

export function renderFees(claimable, pending) {
	const out = [];
	if (!claimable.length && !pending.length) return 'no fees claimable or pending';
	if (claimable.length) {
		out.push('CLAIMABLE NOW');
		for (const c of claimable) {
			out.push(`  ${c.amountFormatted.padStart(24)} ${c.symbol.padEnd(8)} ${c.assetType === 'PROJECT' ? 'project token' : 'stock token'}`
				+ `  locker ${c.lockerAddress}`);
		}
	}
	if (pending.length) {
		out.push('');
		out.push('PENDING (inside the LP, swept roughly hourly)');
		for (const p of pending) {
			out.push(`  ${String(p.amount).padStart(24)} ${String(p.symbol).padEnd(8)}`);
		}
	}
	return out.join('\n');
}

export function usd(n) {
	if (n == null || !Number.isFinite(n)) return '-';
	if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
	if (Math.abs(n) >= 1_000) return `$${Math.round(n).toLocaleString('en-US')}`;
	if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
	return `$${n.toPrecision(2)}`;
}

export function pct(fraction) {
	if (fraction == null || !Number.isFinite(fraction)) return '-';
	const value = fraction > 1 ? fraction : fraction * 100;
	return `${value.toFixed(1)}%`;
}
