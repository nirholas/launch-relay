// Live terminal dashboard.
//
// A relay is a long-running process whose interesting state is spread across
// four places: what the feed is producing, what the rules are doing to it, what
// the wallets hold, and how much of the budget is gone. Scrolling logs answer
// none of those at a glance, which is how an operator ends up not noticing that
// a filter has been rejecting everything for six hours.
//
// Zero dependencies. Terminals have had these escape codes for forty years and
// a dashboard is not a reason to take on a render tree.

// Built from char codes rather than written as escapes, so this file stays
// pure ASCII and no editor, diff, or clipboard round trip can eat a control
// byte and silently break every color in the dashboard.
const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const CTRL_C = String.fromCharCode(3);

const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const CLEAR = `${CSI}2J${CSI}H`;
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;
const RESET = `${CSI}0m`;

const paint = (code) => (s) => `${CSI}${code}m${s}${RESET}`;
const C = {
	bold: paint(1),
	green: paint(32),
	red: paint(31),
	yellow: paint(33),
	cyan: paint(36),
	grey: paint(90),
};

const MAX_EVENTS = 12;

/**
 * @param {object} opts
 * @param {object} opts.relay
 * @param {import('./types.js').Target} opts.target
 * @param {import('./types.js').WalletPool} opts.wallets
 * @param {import('./types.js').Store} opts.store
 * @param {object} opts.budget
 * @param {number} [opts.refreshMs]
 * @param {NodeJS.WriteStream} [opts.out]
 */
export function createDashboard({ relay, target, wallets, store, budget, refreshMs = 1_000, out = process.stdout }) {
	const started = Date.now();
	const events = [];
	let balances = new Map();
	let balancesAt = 0;
	let timer = null;
	let active = false;

	const push = (kind, text) => {
		events.unshift({ kind, text, at: Date.now() });
		if (events.length > MAX_EVENTS) events.pop();
	};

	// Balances cost an RPC round trip per wallet, so they refresh on their own
	// slower clock rather than on every frame.
	async function refreshBalances() {
		if (Date.now() - balancesAt < 15_000) return;
		balancesAt = Date.now();
		const next = new Map();
		for (const handle of wallets.list()) {
			try {
				next.set(handle.address, await handle.balance());
			} catch {
				next.set(handle.address, null);
			}
		}
		balances = next;
	}

	async function render() {
		if (!active) return;
		await refreshBalances();
		const width = Math.max(64, Math.min(out.columns || 100, 120));
		const history = await store.history({ since: Date.now() - 86_400_000 });
		const launched = history.filter((r) => r.status === 'launched');
		const planned = history.filter((r) => r.status === 'planned');
		const lastHour = launched.filter((r) => Date.now() - r.at < 3_600_000);

		const lines = [];
		const rule = (label = '') => lines.push(
			C.grey(label ? `${label} ${'-'.repeat(Math.max(0, width - label.length - 1))}` : '-'.repeat(width)),
		);

		lines.push(
			C.bold('launch-relay')
			+ C.grey(`  ${target.id} on ${target.chain}  up ${duration(Date.now() - started)}`),
		);
		lines.push(relay.mode === 'live' ? C.red('LIVE: this relay can spend') : C.green('DRY RUN: nothing will be signed'));
		rule('wallets');

		for (const handle of wallets.list()) {
			const balance = balances.get(handle.address);
			const usage = wallets.usage?.get(handle.address.toLowerCase());
			lines.push(
				`  ${handle.label.padEnd(7)} ${short(handle.address)} ${balanceBar(balance, budget.reserve)} `
				+ `${(balance == null ? '?' : budget.format(balance)).padStart(12)} ${target.nativeSymbol}`
				+ C.grey(`  ${usage?.launches || 0} launch(es)`),
			);
		}

		rule('budget');
		lines.push(
			`  launches   ${meter(lastHour.length, budget.config.maxLaunchesPerHour)} this hour`
			+ `   ${meter(launched.length, budget.config.maxLaunchesPerDay)} today`,
		);
		const spentToday = launched.reduce((sum, r) => sum + toBase(r.costBase), 0n);
		lines.push(
			`  spend      ${budget.format(spentToday)} / ${budget.config.maxSpendPerDay || 'unlimited'} ${target.nativeSymbol} today`
			+ C.grey(`   reserve ${budget.config.minWalletReserve} per wallet`),
		);
		if (budget.config.killSwitchFile) lines.push(C.grey(`  halt file  ${budget.config.killSwitchFile}`));

		rule('feed');
		if (!events.length) lines.push(C.grey('  waiting for the first graduation...'));
		for (const event of events) {
			lines.push(`  ${C.grey(clock(event.at))} ${tag(event.kind)} ${truncate(event.text, width - 22)}`);
		}

		rule('launched');
		if (!launched.length && !planned.length) lines.push(C.grey('  nothing yet'));
		for (const record of [...launched, ...planned].slice(-4).reverse()) {
			const mark = record.status === 'launched' ? C.green('live') : C.grey('plan');
			lines.push(
				`  ${mark} ${String(record.symbol || '?').padEnd(12)} ${String(record.costNative || '').padEnd(14)} `
				+ C.grey(record.tokenAddress || record.txHash || ''),
			);
		}

		rule();
		lines.push(C.grey('  q or ctrl-c to quit'));

		out.write(CLEAR + lines.join('\n') + '\n');
	}

	return {
		/** Hook these into the relay so the dashboard sees what the engine sees. */
		hooks: {
			onSkip: ({ signal, reason, details, plan }) => {
				if (reason === 'dry-run') {
					push('plan', `${signal.symbol || '?'} priced at ${plan?.cost?.totalNative || '?'} ${plan?.cost?.nativeSymbol || ''}`);
					return;
				}
				if (reason === 'duplicate') return;
				push(reason === 'filtered' ? 'skip' : 'warn', `${signal.symbol || '?'}: ${details?.[0] || reason}`);
			},
			onLaunch: ({ spec, result }) => push('launch', `${spec.symbol} -> ${result.tokenAddress || result.txHash}`),
		},

		start() {
			active = true;
			out.write(ALT_SCREEN_ON + HIDE_CURSOR);
			render();
			timer = setInterval(render, refreshMs);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(true);
				process.stdin.resume();
				process.stdin.on('data', (buf) => {
					const key = buf.toString();
					if (key === 'q' || key === CTRL_C) process.emit('SIGINT');
				});
			}
		},

		stop() {
			active = false;
			if (timer) clearInterval(timer);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false);
				process.stdin.pause();
			}
			out.write(SHOW_CURSOR + ALT_SCREEN_OFF);
		},

		push,
	};
}

function tag(kind) {
	switch (kind) {
		case 'launch': return C.green('LAUNCH');
		case 'plan': return C.cyan('PLAN  ');
		case 'warn': return C.yellow('WARN  ');
		case 'skip': return C.grey('skip  ');
		default: return C.grey('      ');
	}
}

// A ten-cell bar measured against the reserve, so "can this wallet pay" reads
// at a glance instead of requiring arithmetic on a wei count.
export function balanceBar(balance, reserve) {
	if (balance == null) return C.grey('[..........]');
	const floor = reserve > 0n ? reserve : 1n;
	const ratio = Number(balance) / Number(floor * 4n);
	const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)));
	const bar = `${'#'.repeat(filled)}${'.'.repeat(10 - filled)}`;
	if (balance < floor) return C.red(`[${bar}]`);
	if (filled < 4) return C.yellow(`[${bar}]`);
	return C.green(`[${bar}]`);
}

export function meter(used, cap) {
	if (cap == null) return `${used}`;
	const text = `${used}/${cap}`;
	if (used >= cap) return C.red(text);
	if (used >= cap * 0.75) return C.yellow(text);
	return C.green(text);
}

const toBase = (v) => (typeof v === 'bigint' ? v : /^\d+$/.test(String(v ?? '')) ? BigInt(v) : 0n);
const short = (a) => `${a.slice(0, 6)}..${a.slice(-4)}`;
const clock = (at) => new Date(at).toISOString().slice(11, 19);
const truncate = (s, max) => (String(s).length <= max ? String(s) : `${String(s).slice(0, Math.max(0, max - 1))}...`);

export function duration(ms) {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
