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
import { CATALOG_META, findVenue, listVenues, venueKinds } from '../src/chains/robinhood/venues/index.js';
import { describeBindings } from '../src/chains/robinhood/venues/descriptor.js';
import { AMMS, TOKENS } from '../src/chains/robinhood/contracts.js';
import { createManualSource } from '../src/sources/manual.js';

const USAGE = `launch-relay - watch one venue, launch on another, from a pool of wallets

Usage
  launch-relay <command> [options]

Prove it
  doctor                    Check target, wallets, feed, and notification channels
  backtest [--limit n]      Replay real graduations through your rules and report what would have happened
  feed [--limit n]          Recent signals and how the rules judge each one
  plan [--mint <addr>]      Build and price one launch without sending it
  markets                   List the launchpad's pairing markets

Robinhood Chain
  venues [--kind k]         Every launch venue discovered on chain, and what it takes
  venue <id|address>        One venue in full: its ABI, its bindings, its anchor launch
  pools                     Pool shapes you can open yourself, and the quotes available
  launch --name .. --symbol ..
                            Launch one coin on a chosen venue or your own pool

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
  --telegram-url <url>  Telegram link to put on the launched token
  --limit <n>           Row limit
  --mint <address>      Target one specific source coin
  --venue <id>          Robinhood Chain venue to launch on, from the venues list
  --amm <id>            Open your own pool instead: uniswap-v2, uniswap-v3, uniswap-v4
  --quote <sym>         Quote asset for a pool launch (ETH, WETH, USDG, VIRTUAL, or an address)
  --pool-type <t>       full-range or single-sided
  --fee <n>             Pool fee in hundredths of a bip (10000 = 1%)
  --start-fdv <n>       Opening valuation of the whole supply, in quote units
  --quote-amount <n>    Quote to deposit into a two-sided pool
  --name <text>         Token name for the launch command
  --symbol <text>       Token symbol for the launch command
  --image <url>         Token image for the launch command
  --description <text>  Token description for the launch command
  --buy <n>             Opening buy in the venue's quote asset
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
  launch-relay venues --kind bonding-curve
  launch-relay launch --venue virtuals --name "Loop Rat" --symbol LOOPRAT
  launch-relay launch --amm uniswap-v3 --quote WETH --pool-type single-sided --start-fdv 2 --name Frog --symbol FROG
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
		case 'venues': return listVenueCatalog(opts);
		case 'venue': return showVenue(opts);
		case 'pools': return listPools(opts);
		case 'launch': return launchOne(config, opts, mode);
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

// ── Robinhood Chain ──────────────────────────────────────────────────────────

async function listVenueCatalog(opts) {
	const venues = listVenues(opts.kind ? { kind: opts.kind } : {});
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ meta: CATALOG_META, venues }, null, 2)}\n`);
		return;
	}
	if (!venues.length) {
		process.stdout.write(`no venues${opts.kind ? ` of kind "${opts.kind}"` : ''} in the catalog. Kinds: ${venueKinds().join(', ')}\n`);
		return;
	}
	const scanned = CATALOG_META.window
		? `blocks ${CATALOG_META.window.fromBlock}-${CATALOG_META.window.toBlock}`
		: 'an unrecorded window';
	process.stdout.write(`Robinhood Chain launch venues, learned from ${scanned} on ${CATALOG_META.generatedAt || 'an unrecorded date'}\n\n`);
	const rows = venues.map((venue) => [
		venue.liveCheck ? (venue.liveCheck.ok ? 'live' : 'x') : (venue.usable ? 'ok' : '--'),
		venue.id,
		venue.label || '',
		String(venue.observed?.launches ?? 0),
		venue.kind,
		venue.usable
			? `${venue.launch.signature.split('(')[0]}${venue.liveCheck && !venue.liveCheck.ok ? ` (reverts: ${truncate(venue.liveCheck.revert || venue.liveCheck.reason, 34)})` : ''}`
			: truncate(venue.reason || '', 52),
	]);
	writeTable(['', 'id', 'venue', 'seen', 'kind', 'launch fn / why not'], rows);
	const live = venues.filter((v) => v.liveCheck?.ok).length;
	process.stdout.write(`\n${venues.filter((v) => v.usable).length} of ${venues.length} are launchable`);
	process.stdout.write(live ? `, ${live} verified by simulating a real launch against current state.\n` : '.\n');
	process.stdout.write('launch-relay venue <id> for the detail.\n');
}

async function showVenue(opts) {
	const id = opts._[1] || opts.venue;
	if (!id) throw new Error('usage: launch-relay venue <id|address>');
	const venue = findVenue(id);
	if (!venue) throw new Error(`no venue "${id}" in the catalog; run launch-relay venues`);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(venue, null, 2)}\n`);
		return;
	}
	const out = [
		`${venue.label || venue.id}  (${venue.id})`,
		`  contract      ${venue.address}${venue.implementation ? ` behind proxy, implementation ${venue.implementation}` : ''}`,
		`  kind          ${venue.kind}`,
		`  observed      ${venue.observed?.launches ?? 0} launch(es), blocks ${venue.observed?.firstBlock}-${venue.observed?.lastBlock}`,
		`  named by      ${venue.labelSource || 'none'}${venue.labelEvidence ? `: ${venue.labelEvidence}` : ''}`,
	];
	if (!venue.usable) {
		out.push(`  NOT LAUNCHABLE ${venue.reason}`);
		process.stdout.write(`${out.join('\n')}\n`);
		return;
	}
	out.push(
		`  launch fn     ${venue.launch.signature}`,
		`  launch fee    ${formatUnits(BigInt(venue.launch.value), 18)} ETH${venue.launch.valueObserved && venue.launch.valueObserved.max !== venue.launch.valueObserved.min ? ` (observed up to ${formatUnits(BigInt(venue.launch.valueObserved.max), 18)} ETH, which includes creator buys)` : ''}`,
	);
	if (venue.quote) out.push(`  quote asset   ${venue.quote.symbol} ${venue.quote.token}`);
	if (venue.liveCheck) {
		out.push(venue.liveCheck.ok
			? `  live check    a real launch simulated against chain state on ${venue.liveCheck.checkedAt.slice(0, 10)}`
			: `  live check    REVERTS: ${venue.liveCheck.reason}`);
	}
	if (venue.overrideReason) out.push(`  curated       ${venue.overrideReason}`);
	out.push('  fields this toolkit fills in:');
	for (const line of describeBindings(venue)) out.push(`    ${line}`);
	// A pruned field is the most useful thing the probe produces: it says the
	// venue refused to let a launch change that argument, and names the error.
	// "argument 0.8 is replayed, randomising it reverts with
	// LaunchEconomicsMismatch" tells a reader it is a commitment, not a salt.
	for (const rejected of venue.probe?.rejected || []) {
		out.push(`    replayed      arg ${rejected.path.join('.')} looked like the ${rejected.role}, but the venue rejects a new value${rejected.revert ? ` (${rejected.revert})` : ''}`);
	}
	out.push(
		`  anchor        ${venue.evidence.txHash}`,
		`                launched ${venue.evidence.name || '?'} (${venue.evidence.symbol || '?'}) at ${venue.evidence.token}`,
	);
	process.stdout.write(`${out.join('\n')}\n`);
}

async function listPools(opts) {
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ amms: AMMS, quotes: TOKENS }, null, 2)}\n`);
		return;
	}
	process.stdout.write('Pool shapes you can open yourself on Robinhood Chain\n\n');
	writeTable(
		['amm', 'pool types', 'fees', 'entry point'],
		[
			['uniswap-v2', 'full-range', '0.30% fixed', AMMS['uniswap-v2'].router],
			['uniswap-v3', 'full-range, single-sided', Object.keys(AMMS['uniswap-v3'].feeTiers).map((f) => `${Number(f) / 10_000}%`).join(' '), AMMS['uniswap-v3'].positionManager],
			['uniswap-v4', 'full-range, single-sided, hooked', Object.keys(AMMS['uniswap-v4'].feeTiers).map((f) => `${Number(f) / 10_000}%`).join(' '), AMMS['uniswap-v4'].positionManager],
		],
	);
	process.stdout.write(`\nquote assets   ETH (native), ${Object.entries(TOKENS).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
	process.stdout.write('               plus any ERC-20 address, including this chain\'s tokenized stocks\n');
	process.stdout.write('\nsingle-sided opens a pool with no quote deposit: the whole supply is offered\n');
	process.stdout.write('for sale from the starting price upward. Two-sided needs quoteAmount.\n');
}

/**
 * One launch, on a venue or on a pool of your own, from the command line.
 *
 * It runs the same pipeline the relay does, with a manual source of exactly
 * one signal, so the budget, the approval prompt, the ledger and the dry-run
 * default all behave identically to an automated launch.
 */
async function launchOne(config, opts, mode) {
	if (!opts.name || !opts.symbol) throw new Error('launch needs --name and --symbol');
	const target = opts.amm
		? { type: 'pool', amm: opts.amm, quote: opts.quote, poolType: opts.poolType, fee: opts.fee ? Number(opts.fee) : undefined, startFdv: opts.startFdv, startPrice: opts.startPrice, quoteAmount: opts.quoteAmount, supply: opts.supply, rangeMultiple: opts.rangeMultiple ? Number(opts.rangeMultiple) : undefined }
		: { type: 'venue', venue: opts.venue || 'pair', buyAmount: opts.buy };
	if (!opts.amm && !opts.venue) {
		throw new Error('launch needs either --venue <id> (see launch-relay venues) or --amm <id> (see launch-relay pools)');
	}

	const entry = {
		id: `cli-${opts.symbol}-${Date.now()}`,
		kind: 'manual',
		name: opts.name,
		symbol: opts.symbol,
		description: opts.description || '',
		imageUrl: opts.image || null,
		links: { twitter: opts.twitter || null, telegram: opts.telegramUrl || null, website: opts.website || null },
	};

	// Feed rules exist to thin a firehose nobody asked for. This coin was asked
	// for by name, so they are off: filtering it would only ever be the tool
	// refusing an instruction. The budget, the approval and the ledger all
	// still apply, because those bound what a yes costs rather than what
	// reaches a yes.
	const merged = {
		...config,
		target,
		source: { type: 'manual', entries: [entry] },
		rules: { kinds: ['manual'], requireImage: false, requireSocials: 'none', maxSignalAgeSeconds: undefined, denyWords: [], symbolAllow: [], symbolDeny: [], creatorDeny: [] },
		budget: { ...config.budget, maxLaunchesPerHour: 1, maxLaunchesPerDay: 1 },
	};
	// The same approval path a relayed launch takes: a typed yes at the
	// terminal, a tap in Telegram, or an explicit --yes. A dry run needs none
	// of them, and asking for one would teach the habit of saying yes.
	const { relay, target: built } = await buildRelay(merged, {
		logger: log,
		mode,
		confirm: mode === 'live'
			? buildApprover(opts, buildTransports(config.notify, process.env).find((t) => typeof t.ask === 'function'))
			: undefined,
	});
	process.stdout.write(`launching on ${built.id} (${mode})\n`);
	await relay.runOnce();
}

function writeTable(headers, rows) {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
	const line = (cells) => `${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd()}\n`;
	process.stdout.write(line(headers));
	process.stdout.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
	for (const row of rows) process.stdout.write(line(row));
}

// A function declaration, not a const: `main` is awaited at the top of this
// file, so anything it reaches must already be initialised when it runs.
function truncate(value, max) {
	return value.length > max ? `${value.slice(0, max - 3)}...` : value;
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

	// Liveness counters. A managed runtime can only restart what it can see is
	// broken, and "the process is up" says nothing about whether the feed is.
	const pulse = { startedAt: Date.now(), signals: 0, launches: 0, failures: 0, lastLaunchAt: 0, restarts: 0 };

	const built = await buildRelay(config, {
		mode,
		confirm,
		logger: log,
		onSignal: () => { pulse.signals += 1; },
		onLaunch: (event) => {
			pulse.launches += 1;
			pulse.lastLaunchAt = Date.now();
			ui.hooks?.onLaunch(event);
			notifier.launched(event).catch(() => {});
		},
		onSkip: (event) => ui.hooks?.onSkip(event),
		onFailure: (event) => {
			pulse.failures += 1;
			notifier.failed(event).catch(() => {});
		},
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

	// Self-healing. pump.fun graduates coins continuously, so a feed that has
	// gone quiet for this long is a dead feed, not a slow night. Both stream
	// rungs reconnect when their socket closes, but a half-open socket never
	// closes: it just stops delivering. Nothing inside the source can notice
	// that, so this watchdog does. First it restarts the sources in place.
	// If the feed is still silent a full window later, the process exits
	// non-zero and the runtime replaces the container, which also clears
	// anything the in-process restart could not reach.
	const FEED_STALL_MS = Number(process.env.LAUNCH_RELAY_FEED_STALL_MS || 20 * 60_000);
	const feedSilentMs = () => Date.now() - Math.max(relay.lastSignalAt, pulse.startedAt, lastRestartAt);
	const feedStalled = () => feedSilentMs() > FEED_STALL_MS;
	let lastRestartAt = 0;
	const watchdog = setInterval(() => {
		if (!feedStalled()) return;
		const silentMin = Math.round(feedSilentMs() / 60_000);
		if (pulse.restarts > 0 && Date.now() - lastRestartAt > FEED_STALL_MS) {
			log.error(`feed still silent ${silentMin}m after an in-process restart; exiting so the runtime replaces this instance`);
			notifier.status(`launch-relay: feed dead for ${silentMin}m, restarting the container`).catch(() => {});
			process.exit(1);
		}
		log.warn(`feed silent for ${silentMin}m; restarting sources`);
		pulse.restarts += 1;
		lastRestartAt = Date.now();
		relay.restart();
	}, 60_000);
	watchdog.unref();

	// A crash must be a crash. A swallowed error leaves a process that answers
	// probes and does nothing; a loud exit gets a fresh instance.
	const crash = (label) => (err) => {
		log.error(`${label}: ${err?.stack || err}`);
		process.exit(1);
	};
	process.on('uncaughtException', crash('uncaught exception'));
	process.on('unhandledRejection', crash('unhandled rejection'));

	// Bound before the feed and the notifier are touched. A startup probe is on
	// a clock, and a slow WebSocket handshake must not read as a dead process.
	// A managed runtime needs something to probe to know the process is alive,
	// and an operator needs somewhere to read the counters without tailing a
	// log. One endpoint serves both. Only bound when PORT is set, so nothing
	// changes for a local run.
	let health;
	if (process.env.PORT) {
		const { createServer } = await import('node:http');
		const startedAt = Date.now();
		health = createServer((req, res) => {
			const stalled = feedStalled();
			const body = JSON.stringify({
				status: stalled ? 'stalled' : 'ok',
				mode,
				target: target.id,
				chain: target.chain,
				uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
				feedSilentSeconds: Math.round(feedSilentMs() / 1000),
				signals: pulse.signals,
				launches: pulse.launches,
				failures: pulse.failures,
				lastLaunchAt: pulse.lastLaunchAt || null,
				feedRestarts: pulse.restarts,
				wallets: wallets.list().map((w) => w.address),
			});
			// 503 is what a liveness probe reads as "replace me". A stalled feed
			// with a healthy process is exactly the state that needs replacing.
			res.writeHead(stalled ? 503 : 200, { 'content-type': 'application/json' }).end(body);
		});
		health.listen(Number(process.env.PORT), '0.0.0.0', () => {
			log.info(`health endpoint on :${process.env.PORT}`);
		});
	}

	if (notifier.enabled) {
		await notifier.status(`launch-relay started in ${mode} mode: ${target.id} on ${target.chain}`).catch(() => {});
	}

	relay.start();
	dash?.start();

	const shutdown = () => {
		dash?.stop();
		relay.stop();
		telegram?.stop?.();
		health?.close();
		clearInterval(watchdog);
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
		const takesValue = [
			'config', 'limit', 'mint', 'target', 'from',
			// Robinhood Chain launching.
			'venue', 'kind', 'amm', 'quote', 'pool-type', 'fee', 'start-fdv', 'start-price',
			'quote-amount', 'range-multiple', 'supply', 'buy', 'name', 'symbol', 'image',
			'description', 'twitter', 'telegram-url', 'website',
		].includes(key);
		if (takesValue) out[camel(key)] = argv[++i];
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
