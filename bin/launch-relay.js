#!/usr/bin/env node
// launch-relay CLI.
//
// The commands are ordered the way you should use them: `doctor` proves the
// wiring, `feed` shows what the rules would do to real events, `plan` prices a
// single launch without sending it, `run --once` walks the whole pipeline in
// dry-run, and only then does `run --live` exist as an option.
//
// Live mode has two independent locks and needs both:
//
//   1. LAUNCH_RELAY_ARMED=1 in the environment. Deliberate, out of band, and
//      absent by default, so no config file or flag can turn spending on by
//      itself.
//   2. A yes for each launch. Interactively that is typing "yes" at a prompt
//      showing the wallet, the contract, and the total cost. Unattended it is
//      --yes, which is the operator pre-authorizing every launch the budget
//      permits: the budget caps are the real limit in that mode, so set them.

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { formatUnits } from 'viem';
import { buildRelay, loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { createRules } from '../src/rules.js';
import { createMapper } from '../src/mapping.js';

const USAGE = `launch-relay - watch one venue, launch on another, from a pool of wallets

Usage
  launch-relay <command> [options]

Commands
  doctor                 Check the target, wallets, and feed before trusting anything else
  wallets                List the wallet pool with live balances
  feed [--limit n]       Show recent source signals and how the rules judge each one
  plan [--mint <addr>]   Build and price one launch without sending it
  run [--once]           Run the relay
  ledger [--limit n]     Show recent ledger records
  markets                List the launchpad's available pairing markets

Options
  --config <path>        Config file (JSON). Defaults to launch-relay.config.json when present
  --live                 Spend real funds. Requires LAUNCH_RELAY_ARMED=1
  --yes                  Pre-approve every launch the budget permits (unattended live runs)
  --limit <n>            Row limit for feed and ledger
  --mint <address>       Target one specific source coin
  --debug                Verbose logging
  --help                 This text

Environment
  LAUNCH_RELAY_ARMED       Must be "1" for --live
  LAUNCH_RELAY_MNEMONIC    Seed phrase for the EVM wallet pool
  LAUNCH_RELAY_EVM_KEYS    Comma-separated private keys (alternative to the mnemonic)
  LAUNCH_RELAY_SOLANA_KEYS Comma-separated base58 secret keys, for Solana targets
  LAUNCH_RELAY_RPC_URL     Override the target chain's RPC
  LAUNCH_RELAY_DEBUG       Same as --debug

Examples
  launch-relay doctor
  launch-relay feed --limit 20
  launch-relay run --once
  LAUNCH_RELAY_ARMED=1 launch-relay run --live
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
		case 'ledger': return ledger(config, opts);
		case 'run': return run(config, opts, mode);
		default:
			process.stdout.write(USAGE);
			process.exitCode = 1;
			return undefined;
	}
}

// ── commands ─────────────────────────────────────────────────────────────────

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
			`${String(t.symbol).padEnd(8)} ${t.address}  ${t.enabled ? 'enabled ' : 'disabled'}  ${String(t.launchedTokenCount ?? 0).padStart(4)} launches\n`,
		);
	}
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
				`${verdict.pass ? 'PASS' : 'skip'}  ${String(signal.symbol || '?').padEnd(12)} ${(cap == null ? 'cap ?' : `$${Math.round(cap).toLocaleString('en-US')}`).padEnd(12)} ${`${age}s ago`.padEnd(10)} ${signal.name || ''}\n`,
			);
			if (verdict.pass) {
				const spec = await mapper.map(signal).catch((err) => ({ error: err.message }));
				process.stdout.write(
					spec.error
						? `      would not map: ${spec.error}\n`
						: `      -> ${spec.name} (${spec.symbol})\n`,
				);
			} else {
				process.stdout.write(`      ${verdict.reasons.join('; ')}\n`);
			}
		}
	}
}

async function planOne(config, opts) {
	const { relay, target, wallets, sources } = await buildRelay(config, { logger: log });
	const rules = createRules({ ...config.rules, maxSignalAgeSeconds: null });
	const mapper = createMapper(config.mapper);

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
	const wallet = await wallets.pick({});
	if (!wallet) throw new Error('no wallet available to price the launch');

	const plan = await target.plan(spec, { wallet, log, dryRun: true });
	process.stdout.write(`\n${renderPlan(plan)}\n`);
	process.stdout.write(`(dry run, nothing was sent; relay mode is ${relay.mode})\n`);
}

async function ledger(config, opts) {
	const { store } = await buildRelay(config, { logger: log });
	const records = await store.history({ since: 0 });
	const rows = records.slice(-Number(opts.limit || 20));
	if (!rows.length) {
		process.stdout.write('ledger is empty\n');
		return;
	}
	for (const r of rows) {
		process.stdout.write(
			`${new Date(r.at).toISOString()}  ${String(r.status).padEnd(9)} ${String(r.symbol || '?').padEnd(12)} ${String(r.costNative || '').padEnd(12)} ${r.tokenAddress || r.txHash || ''}\n`,
		);
	}
}

async function run(config, opts, mode) {
	const confirm = mode === 'live' ? makeConfirm(opts) : undefined;
	const { relay } = await buildRelay(config, { mode, confirm, logger: log });

	if (opts.once) {
		await relay.runOnce();
		relay.stop();
		return;
	}

	relay.start();
	const shutdown = () => {
		relay.stop();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	// Hold the process open; the sources own every timer from here.
	await new Promise(() => {});
}

// ── live-mode gates ──────────────────────────────────────────────────────────

function assertArmed() {
	if (process.env.LAUNCH_RELAY_ARMED === '1') return;
	throw new Error(
		'--live refused: set LAUNCH_RELAY_ARMED=1 to arm this machine for spending. '
		+ 'Run `launch-relay run --once` first and read the ledger.',
	);
}

/**
 * Per-launch approval. Interactive by default: the plan is printed in full and
 * the operator types yes. `--yes` replaces the prompt with standing approval,
 * which is the only way an unattended relay can launch anything.
 */
function makeConfirm(opts) {
	if (opts.yes) {
		return async (plan) => {
			process.stdout.write(`\n${renderPlan(plan)}\napproved by --yes\n\n`);
			return true;
		};
	}
	if (!process.stdin.isTTY) {
		throw new Error(
			'live mode has no terminal to confirm on. Pass --yes to pre-approve every launch the budget permits.',
		);
	}
	return async (plan) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			process.stdout.write(`\n${renderPlan(plan)}\n`);
			const answer = await rl.question('send this launch? type yes to sign: ');
			return answer.trim().toLowerCase() === 'yes';
		} finally {
			rl.close();
		}
	};
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderPlan(plan) {
	const lines = [
		'  LAUNCH PLAN',
		'  ' + '-'.repeat(66),
		...plan.summary.map((l) => `  ${l}`),
	];
	if (plan.warnings?.length) {
		lines.push('  ' + '-'.repeat(66));
		for (const w of plan.warnings) lines.push(`  warning     ${w}`);
	}
	lines.push('  ' + '-'.repeat(66));
	return lines.join('\n');
}

function fmtNative(balance, target) {
	const decimals = target.nativeDecimals ?? 18;
	const value = formatUnits(balance, decimals);
	const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
	return `${trimmed} ${target.nativeSymbol}`;
}

// ── argv ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) { out._.push(arg); continue; }
		const key = arg.slice(2);
		const takesValue = ['config', 'limit', 'mint'].includes(key);
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
