#!/usr/bin/env node
// launch-relay CLI.
//
// The commands are ordered the way you should use them. `doctor` proves the
// wiring. `backtest` tells you whether your rules are worth funding, using
// graduations that already happened. `feed` and `plan` show the live decision
// without sending anything. `run --once` walks the whole pipeline in dry-run.
// Only then does `--live` exist as an option, and even then it needs two keys
// turned at once:
//
//   1. LAUNCH_RELAY_ARMED=1 in the environment. Deliberate, out of band, and
//      absent by default, so no config file or stray flag can enable spending.
//   2. An approval per launch: a typed yes at the terminal, a tap in Telegram,
//      or an explicit --yes standing authorization bounded by the budget.

import { readFile } from 'node:fs/promises';
import { createPublicClient, formatUnits, http } from 'viem';
import { buildRelay, loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { createBudget } from '../src/budget.js';
import { PAIR_LAUNCHPAD_V5, launchpadAbi } from '../src/targets/pairfund/abi.js';
import { createRules } from '../src/rules.js';
import { createMapper } from '../src/mapping.js';
import { createMarketSelector } from '../src/targets/pairfund/markets.js';
import { backtest, fetchGraduationHistory } from '../src/backtest.js';
import { executeClaims, fetchClaimable, fetchPending, planClaims } from '../src/targets/pairfund/fees.js';
import { buildPortfolio, summarizeEconomics } from '../src/positions.js';
import { executeFunding, planFunding } from '../src/wallets/fund.js';
import { buildTransports, createNotifier } from '../src/notify/index.js';
import { createStandingApproval, createTelegramApproval, createTerminalApproval, requireAll } from '../src/approvals.js';
import { createDashboard } from '../src/tui.js';
import { renderBacktest, renderFees, renderPlan, renderPositions } from '../src/report.js';

const USAGE = `launch-relay - watch one venue, launch on another, from a pool of wallets

Usage
  launch-relay <command> [options]

Prove it
  doctor                    Check target, wallets, feed, and notification channels
  backtest [--limit n]      Replay real graduations through your rules and report what would have happened
  feed [--limit n]          Recent signals and how the rules judge each one
  plan [--mint <addr>]      Build and price one launch without sending it
  markets                   List the launchpad's pairing markets

Run it
  run [--once]              Run the relay
  watch                     Run with a live dashboard

Own it
  positions                 Portfolio of everything launched, with live market data
  fees                      Claimable and pending creator fees
  claim                     Claim creator fees (on-chain, asks first)
  fund --target <amount>    Level every wallet in the pool from the richest one
  ledger [--limit n]        Recent ledger records

Options
  --config <path>       Config file. Defaults to ./launch-relay.config.json
  --live                Spend real funds. Requires LAUNCH_RELAY_ARMED=1
  --yes                 Standing approval for every launch the budget permits
  --telegram            Approve each launch from Telegram instead of the terminal
  --limit <n>           Row limit
  --mint <address>      Target one specific source coin
  --target <amount>     Per-wallet target balance for fund
  --from <address>      Source wallet for fund
  --json                Machine-readable output where supported
  --debug               Verbose logging

Environment
  LAUNCH_RELAY_ARMED              Must be "1" for --live
  LAUNCH_RELAY_MNEMONIC           Seed phrase for the EVM wallet pool
  LAUNCH_RELAY_EVM_KEYS           Comma-separated private keys
  LAUNCH_RELAY_SOLANA_KEYS        Base58 secret keys, for Solana targets
  LAUNCH_RELAY_RPC_URL            Override the target chain RPC
  LAUNCH_RELAY_TELEGRAM_TOKEN     Bot token, for notifications and approvals
  LAUNCH_RELAY_TELEGRAM_CHAT_ID   Chat that receives them
  LAUNCH_RELAY_TELEGRAM_USER_IDS  Optional allowlist of users who may approve
  LAUNCH_RELAY_WEBHOOK_URL        Generic JSON webhook for launch events

Examples
  launch-relay backtest --limit 500
  launch-relay run --once
  LAUNCH_RELAY_ARMED=1 launch-relay run --live --telegram
`;

const args = parseArgs(process.argv.slice(2));
if (args.help || !args._[0]) {
	process.stdout.write(USAGE);
	process.exit(args.help ? 0 : 1);
}
if (args.debug) process.env.LAUNCH_RELAY_DEBUG = '1';

const log = createLogger('cli');

try {
	await main(args._[0], args);
} catch (err) {
	log.error(err?.stack || err?.message || String(err));
	process.exitCode = 1;
}

async function main(command, opts) {
	const config = await loadConfig(await resolveConfigPath(opts.config));
	const mode = opts.live ? 'live' : 'dry-run';
	if (mode === 'live') assertArmed();

	switch (command) {
		case 'doctor': return doctor(config);
		case 'wallets': return listWallets(config);
		case 'markets': return listMarkets(config);
		case 'feed': return feed(config, opts);
		case 'plan': return planOne(config, opts);
		case 'backtest': return runBacktest(config, opts);
		case 'positions': return positions(config, opts);
		case 'fees': return fees(config, opts);
		case 'claim': return claim(config, opts);
		case 'fund': return fund(config, opts);
		case 'ledger': return ledger(config, opts);
		case 'watch': return run(config, opts, mode, { dashboard: true });
		case 'run': return run(config, opts, mode, {});
		default:
			process.stdout.write(USAGE);
			process.exitCode = 1;
			return undefined;
	}
}

// ── prove it ─────────────────────────────────────────────────────────────────

async function doctor(config) {
	const { target, wallets, sources, store } = await buildRelay(config, { logger: log });
	let failures = 0;
	const line = (ok, label, detail) => {
		if (!ok) failures++;
		process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(22)} ${detail}\n`);
	};

	line(true, 'target', `${target.id} on ${target.chain}${target.chainId ? ` (chain ${target.chainId})` : ''}`);
	if (typeof target.health === 'function') {
		try {
			const health = await target.health();
			line(health.ok, 'target health', health.detail);
		} catch (err) {
			line(false, 'target health', err.message);
		}
	}

	const handles = wallets.list();
	line(handles.length > 0, 'wallet pool', `${handles.length} wallet(s)`);
	let funded = 0;
	for (const handle of handles) {
		try {
			const balance = await handle.balance();
			if (balance > 0n) funded++;
			line(true, `  ${handle.label}`, `${handle.address}  ${fmtNative(balance, target)}`);
		} catch (err) {
			line(false, `  ${handle.label}`, `${handle.address}  balance unreadable: ${err.message}`);
		}
	}
	line(funded > 0, 'funded wallets', `${funded}/${handles.length} hold a balance`);

	for (const source of sources) {
		if (typeof source.poll !== 'function') {
			line(true, `source ${source.id}`, 'push-only, verified at run time');
			continue;
		}
		try {
			const signals = await source.poll({ log });
			line(signals.length > 0, `source ${source.id}`, `${signals.length} recent signal(s)`);
		} catch (err) {
			line(false, `source ${source.id}`, err.message);
		}
	}

	const transports = buildTransports(config.notify, process.env);
	if (!transports.length) {
		line(true, 'notifications', 'none configured (optional)');
	} else {
		for (const transport of transports) {
			if (typeof transport.check !== 'function') {
				line(true, 'notifications', 'webhook configured');
				continue;
			}
			try {
				const me = await transport.check();
				line(true, 'telegram', `connected as @${me.username}, test message sent`);
			} catch (err) {
				line(false, 'telegram', err.message);
			}
		}
	}

	const history = await store.history({ since: 0 });
	line(true, 'ledger', `${history.length} record(s)${store.paths ? ` in ${store.paths.dir}` : ' (memory only)'}`);
	line(true, 'mode', process.env.LAUNCH_RELAY_ARMED === '1' ? 'armed for --live' : 'not armed (dry-run only)');

	if (failures) {
		process.stdout.write(`\n${failures} check(s) failed\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write('\nall checks passed\n');
	}
}

async function runBacktest(config, opts) {
	const limit = Number(opts.limit || 300);
	process.stderr.write(`pulling ${limit} historical graduations from pump.fun...\n`);
	const signals = await fetchGraduationHistory({
		limit,
		onProgress: (msg) => process.stderr.write(`  ${msg}\n`),
	});
	if (!signals.length) throw new Error('no historical graduations available right now');

	// Pull the live market list and launch cost so the replay is priced against
	// what a launch costs today, not a number baked into the source.
	const { target } = await buildRelay(config, { logger: log }).catch(() => ({ target: null }));
	let markets = [];
	let costPerLaunch;
	if (target?.api?.stockTokens) {
		markets = await target.api.stockTokens().catch(() => []);
		costPerLaunch = await liveLaunchCost(target).catch(() => undefined);
	}

	const report = await backtest({
		signals,
		rules: config.rules,
		mapper: config.mapper,
		budget: config.budget,
		marketSelector: createMarketSelector(config.target?.markets || {}),
		markets,
		costPerLaunch,
		walletCount: config.wallets?.count || 3,
	});

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(report, bigintReplacer, 2)}\n`);
		return;
	}
	process.stdout.write(`\n${renderBacktest(report)}\n`);
}

async function feed(config, opts) {
	const { sources } = await buildRelay(config, { logger: log });
	const rules = createRules(config.rules);
	const mapper = createMapper(config.mapper);
	const limit = Number(opts.limit || 15);

	for (const source of sources) {
		if (typeof source.poll !== 'function') continue;
		const signals = (await source.poll({ log })).slice(0, limit);
		process.stdout.write(`\n${source.id}: ${signals.length} signal(s)\n\n`);
		for (const signal of signals) {
			const verdict = await rules.evaluate(signal);
			const age = Math.round((Date.now() - signal.at) / 1000);
			const cap = signal.metrics?.marketCapUsd;
			process.stdout.write(
				`${verdict.pass ? 'PASS' : 'skip'}  ${String(signal.symbol || '?').padEnd(12)} `
				+ `${(cap == null ? 'cap ?' : `$${Math.round(cap).toLocaleString('en-US')}`).padEnd(12)} `
				+ `${`${age}s ago`.padEnd(10)} ${signal.name || ''}\n`,
			);
			if (verdict.pass) {
				const spec = await mapper.map(signal).catch((err) => ({ error: err.message }));
				process.stdout.write(spec.error ? `      would not map: ${spec.error}\n` : `      -> ${spec.name} (${spec.symbol})\n`);
			} else {
				process.stdout.write(`      ${verdict.reasons.join('; ')}\n`);
			}
		}
	}
}

async function planOne(config, opts) {
	const { relay, target, wallets, sources } = await buildRelay(config, { logger: log });
	const mapper = createMapper(config.mapper);
	const rules = createRules({ ...config.rules, maxSignalAgeSeconds: null });

	const signals = [];
	for (const source of sources) {
		if (typeof source.poll === 'function') signals.push(...(await source.poll({ log })));
	}
	const signal = opts.mint
		? signals.find((s) => s.address === opts.mint || s.id.endsWith(opts.mint))
		: signals[0];
	if (!signal) throw new Error(opts.mint ? `no recent signal for mint ${opts.mint}` : 'no signals available to plan');

	const verdict = await rules.evaluate(signal);
	if (!verdict.pass) log.warn(`this signal would be filtered in a real run: ${verdict.reasons.join('; ')}`);

	const spec = await mapper.map(signal);
	const wallet = (await wallets.pick({})) || wallets.list()[0];
	if (!wallet) throw new Error('no wallet available to price the launch');

	const plan = await target.plan(spec, { wallet, log, dryRun: true });
	process.stdout.write(`\n${renderPlan(plan)}\n`);
	process.stdout.write(`(dry run, nothing was sent; relay mode is ${relay.mode})\n`);
}

async function listWallets(config) {
	const { target, wallets } = await buildRelay(config, { logger: log });
	for (const handle of wallets.list()) {
		const balance = await handle.balance().catch(() => null);
		process.stdout.write(
			`${handle.label.padEnd(8)} ${handle.address}  ${balance == null ? 'unreadable' : fmtNative(balance, target)}\n`,
		);
	}
}

async function listMarkets(config) {
	const { target } = await buildRelay(config, { logger: log });
	if (!target.api?.stockTokens) {
		process.stdout.write(`${target.id} has no pairing markets\n`);
		return;
	}
	const tokens = await target.api.stockTokens();
	process.stdout.write(`${tokens.length} market(s) on ${target.id}\n\n`);
	for (const t of tokens) {
		process.stdout.write(
			`${String(t.symbol).padEnd(8)} ${t.address}  ${t.enabled ? 'enabled ' : 'disabled'}  `
			+ `${String(t.launchedTokenCount ?? 0).padStart(4)} launches\n`,
		);
	}
}

// ── own it ───────────────────────────────────────────────────────────────────

async function positions(config, opts) {
	const { target, store, wallets } = await buildRelay(config, { logger: log });
	if (!target.api) throw new Error(`${target.id} does not expose a portfolio API`);

	const portfolio = await buildPortfolio({
		store, api: target.api, decimals: target.nativeDecimals, nativeSymbol: target.nativeSymbol,
	});

	const claimable = [];
	const pending = [];
	for (const handle of wallets.list()) {
		claimable.push(...await fetchClaimable(target.api, handle.address).catch(() => []));
		pending.push(...await fetchPending(target.api, handle.address).catch(() => []));
	}
	const economics = summarizeEconomics({ portfolio, claimable, pending });

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ portfolio, economics }, bigintReplacer, 2)}\n`);
		return;
	}
	if (!portfolio.positions.length) {
		process.stdout.write('nothing launched yet. run `launch-relay run --once` to see what it would do.\n');
		return;
	}
	process.stdout.write(`\n${renderPositions(portfolio, economics)}\n`);
}

async function fees(config, opts) {
	const { target, wallets } = await buildRelay(config, { logger: log });
	if (!target.api?.feesClaimable) throw new Error(`${target.id} has no fee API`);

	let found = 0;
	for (const handle of wallets.list()) {
		const claimable = await fetchClaimable(target.api, handle.address);
		const pending = await fetchPending(target.api, handle.address);
		if (claimable.length || pending.length) found++;
		else if (!opts.all) continue;
		process.stdout.write(`\n${handle.label}  ${handle.address}\n`);
		process.stdout.write(`${renderFees(claimable, pending)}\n`);
	}
	if (!found) {
		process.stdout.write(
			`no fees across ${wallets.list().length} wallet(s) yet.\n`
			+ 'Fees accrue as people trade tokens you launched, and the PAIR keeper\n'
			+ 'sweeps them into the locker roughly hourly before they become claimable.\n',
		);
	}
}

async function claim(config, opts) {
	const { target, wallets } = await buildRelay(config, { logger: log });
	if (!target.api?.feesClaimable) throw new Error(`${target.id} has no fee API`);

	let claimedAnything = false;
	for (const handle of wallets.list()) {
		const rows = await fetchClaimable(target.api, handle.address);
		if (!rows.length) continue;
		const plan = await planClaims({ rows, wallet: handle });

		process.stdout.write(`\n  CLAIM PLAN\n  ${'-'.repeat(68)}\n`);
		for (const line of plan.summary) process.stdout.write(`  ${line}\n`);
		process.stdout.write(`  ${'-'.repeat(68)}\n`);

		// Claiming your own fees is still an on-chain transaction from your key,
		// so it asks, exactly like a launch does.
		if (!(await confirmPrompt(opts, 'send these claims? type yes to sign: '))) {
			process.stdout.write('  skipped\n');
			continue;
		}
		await executeClaims({ claims: plan.claims, wallet: handle, chain: target.viemChain, log });
		claimedAnything = true;
	}
	if (!claimedAnything) process.stdout.write('nothing to claim\n');
}

async function fund(config, opts) {
	if (!opts.target) throw new Error('fund needs --target <amount>, the balance every wallet should reach');
	const { target, wallets } = await buildRelay(config, { logger: log });
	const plan = await planFunding({
		wallets, target: opts.target, from: opts.from, reserve: config.budget?.minWalletReserve || '0.001',
	});

	process.stdout.write(`\n  FUNDING PLAN\n  ${'-'.repeat(68)}\n`);
	for (const line of plan.summary) process.stdout.write(`  ${line}\n`);
	process.stdout.write(`  ${'-'.repeat(68)}\n`);

	if (!plan.transfers.length) {
		process.stdout.write('every wallet already holds the target balance\n');
		return;
	}
	if (plan.shortfallWei > 0n) {
		process.stdout.write('fund the source wallet first, then run this again\n');
		process.exitCode = 1;
		return;
	}
	if (!(await confirmPrompt(opts, 'send these transfers? type yes to sign: '))) {
		process.stdout.write('cancelled\n');
		return;
	}
	await executeFunding({ plan, wallets, chain: target.viemChain, log });
}

async function ledger(config, opts) {
	const { store } = await buildRelay(config, { logger: log });
	const records = await store.history({ since: 0 });
	const rows = records.slice(-Number(opts.limit || 20));
	if (!rows.length) {
		process.stdout.write('ledger is empty\n');
		return;
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(rows, bigintReplacer, 2)}\n`);
		return;
	}
	for (const r of rows) {
		process.stdout.write(
			`${new Date(r.at).toISOString()}  ${String(r.status).padEnd(9)} ${String(r.symbol || '?').padEnd(12)} `
			+ `${String(r.costNative || '').padEnd(12)} ${r.tokenAddress || r.txHash || ''}`
			+ `${r.budgetBlock ? `  (would be blocked: ${r.budgetBlock})` : ''}\n`,
		);
	}
}

// ── run it ───────────────────────────────────────────────────────────────────

async function run(config, opts, mode, { dashboard }) {
	const transports = buildTransports(config.notify, process.env);
	const notifier = createNotifier(transports, { logger: log });
	const telegram = transports.find((t) => typeof t.ask === 'function');
	const confirm = mode === 'live' ? buildApprover(opts, telegram) : undefined;

	// The dashboard needs the relay and the relay needs the dashboard's hooks,
	// so the engine gets stable wrappers and the UI fills them in once it
	// exists. Without this the two would have to be built in the same breath.
	const ui = { hooks: null };

	const built = await buildRelay(config, {
		mode,
		confirm,
		logger: log,
		onLaunch: (event) => {
			ui.hooks?.onLaunch(event);
			notifier.launched(event).catch(() => {});
		},
		onSkip: (event) => ui.hooks?.onSkip(event),
		onFailure: (event) => notifier.failed(event).catch(() => {}),
	});
	const { relay, target, wallets, store } = built;

	let dash = null;
	if (dashboard) {
		dash = createDashboard({
			relay,
			target,
			wallets,
			store,
			budget: createBudget(config.budget, {
				decimals: target.nativeDecimals ?? 18,
				nativeSymbol: target.nativeSymbol,
			}),
		});
		ui.hooks = dash.hooks;
	}

	if (opts.once) {
		await relay.runOnce();
		relay.stop();
		return;
	}

	if (notifier.enabled) {
		await notifier.status(`launch-relay started in ${mode} mode: ${target.id} on ${target.chain}`).catch(() => {});
	}

	relay.start();
	dash?.start();

	// A managed runtime needs something to probe to know the process is alive,
	// and an operator needs somewhere to read the counters without tailing a
	// log. One endpoint serves both. Only bound when PORT is set, so nothing
	// changes for a local run.
	let health;
	if (process.env.PORT) {
		const { createServer } = await import('node:http');
		const startedAt = Date.now();
		health = createServer((req, res) => {
			const body = JSON.stringify({
				status: 'ok',
				mode,
				target: target.id,
				chain: target.chain,
				uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
				wallets: wallets.list().map((w) => w.address),
			});
			res.writeHead(200, { 'content-type': 'application/json' }).end(body);
		});
		health.listen(Number(process.env.PORT), '0.0.0.0', () => {
			log.info(`health endpoint on :${process.env.PORT}`);
		});
	}

	const shutdown = () => {
		dash?.stop();
		relay.stop();
		telegram?.stop?.();
		health?.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	await new Promise(() => {});
}

// ── live-mode gates ──────────────────────────────────────────────────────────

function assertArmed() {
	if (process.env.LAUNCH_RELAY_ARMED === '1') return;
	throw new Error(
		'--live refused: set LAUNCH_RELAY_ARMED=1 to arm this machine for spending. '
		+ 'Run `launch-relay backtest` and `launch-relay run --once` first.',
	);
}

/**
 * Pick who gets to say yes. Telegram and the terminal can be combined, in which
 * case both must approve, which is the right default for a shared treasury.
 */
function buildApprover(opts, telegram) {
	if (opts.telegram) {
		if (!telegram) {
			throw new Error(
				'--telegram needs LAUNCH_RELAY_TELEGRAM_TOKEN and LAUNCH_RELAY_TELEGRAM_CHAT_ID. '
				+ 'Run `launch-relay doctor` to verify them.',
			);
		}
		const approver = createTelegramApproval({ client: telegram, log });
		return opts.yes ? approver : requireAllAvailable(approver, opts);
	}
	if (opts.yes) return createStandingApproval({ render: renderPlan, log });
	return createTerminalApproval({ render: renderPlan });
}

// A terminal approval on top of Telegram only makes sense when there IS a
// terminal. Headless is the normal way to run this, so it degrades to Telegram
// alone rather than refusing to start.
function requireAllAvailable(telegramApprover, opts) {
	if (!process.stdin.isTTY) return telegramApprover;
	return requireAll([telegramApprover, createTerminalApproval({ render: renderPlan })]);
}

async function confirmPrompt(opts, question) {
	if (opts.yes) {
		if (process.env.LAUNCH_RELAY_ARMED !== '1') {
			throw new Error('--yes on a spending command requires LAUNCH_RELAY_ARMED=1');
		}
		process.stdout.write('  approved by --yes\n');
		return true;
	}
	if (!process.stdin.isTTY) throw new Error('no terminal to confirm on; pass --yes with LAUNCH_RELAY_ARMED=1');
	const { createInterface } = await import('node:readline/promises');
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(`  ${question}`);
		return answer.trim().toLowerCase() === 'yes';
	} finally {
		rl.close();
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Price the backtest against what a launch costs right now rather than a
// constant baked into the source, so an old report cannot quietly understate
// today's fee or gas.
async function liveLaunchCost(target) {
	if (!target?.viemChain) return undefined;
	const publicClient = createPublicClient({ chain: target.viemChain, transport: http() });
	const fee = await publicClient.readContract({
		address: PAIR_LAUNCHPAD_V5, abi: launchpadAbi, functionName: 'launchFeeWei',
	});
	const gasPrice = await publicClient.getGasPrice();
	// 3.45M gas is the buffered estimate a real PAIR launch settles around.
	return fee + 3_450_000n * gasPrice;
}

function fmtNative(balance, target) {
	const value = formatUnits(balance, target.nativeDecimals ?? 18);
	const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
	return `${trimmed} ${target.nativeSymbol}`;
}

const bigintReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) { out._.push(arg); continue; }
		const key = arg.slice(2);
		const takesValue = ['config', 'limit', 'mint', 'target', 'from'].includes(key);
		if (takesValue) out[key] = argv[++i];
		else out[camel(key)] = true;
	}
	return out;
}

// Declared, not assigned to a const: parseArgs runs at module top level, above
// this point in the file, and a const arrow would be in its temporal dead zone.
function camel(s) {
	return s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

async function resolveConfigPath(explicit) {
	if (explicit) return explicit;
	const fallback = 'launch-relay.config.json';
	try {
		await readFile(fallback, 'utf8');
		return fallback;
	} catch {
		return null;
	}
}
