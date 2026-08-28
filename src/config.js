// Config loading and wiring.
//
// One JSON file describes the relay, and secrets never appear in it. Keys come
// from the environment, which keeps the config safe to commit, diff, and share
// while the thing that can spend money stays outside the repo.
//
// `buildRelay` is the bridge from that document to live adapters. Everything it
// constructs is also constructible by hand: the config file is a convenience
// for the CLI, not a requirement for using the library.

import { readFile } from 'node:fs/promises';
import { createRelay } from './engine.js';
import { createLogger } from './log.js';
import { createFileStore } from './store/file.js';
import { createMemoryStore } from './store/memory.js';
import { createManualSource } from './sources/manual.js';
import { createPumpFunGraduationSource } from './sources/pumpfun-graduations.js';
import { createPairFundTarget } from './targets/pairfund/index.js';
import { createPumpFunTarget } from './targets/pumpfun.js';
import { createEvmWalletPool } from './wallets/evm.js';
import { createSolanaWalletPool } from './wallets/solana.js';

export const DEFAULT_CONFIG = Object.freeze({
	mode: 'dry-run',
	source: { type: 'pumpfun-graduations' },
	target: { type: 'pairfund' },
	wallets: { type: 'evm', count: 3, strategy: 'round-robin' },
	rules: {},
	mapper: {},
	budget: {},
	store: { dir: '.ledger' },
});

/**
 * Read a config file and merge it over the defaults. A missing file is not an
 * error: the defaults describe a working dry-run relay, which is what someone
 * running the tool for the first time should get.
 *
 * @param {string} [path]
 * @returns {Promise<object>}
 */
export async function loadConfig(path) {
	if (!path) return structuredClone(DEFAULT_CONFIG);
	let text;
	try {
		text = await readFile(path, 'utf8');
	} catch (err) {
		if (err?.code === 'ENOENT') throw new Error(`config file not found: ${path}`);
		throw err;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`config file ${path} is not valid JSON: ${err.message}`);
	}
	return mergeDeep(structuredClone(DEFAULT_CONFIG), parsed);
}

/**
 * Turn a config document into a running relay.
 *
 * @param {object} config
 * @param {object} [overrides]
 * @param {'dry-run'|'live'} [overrides.mode]
 * @param {(plan: object) => Promise<boolean>} [overrides.confirm]
 * @param {import('./types.js').Logger} [overrides.logger]
 * @param {NodeJS.ProcessEnv} [overrides.env]
 */
export async function buildRelay(config, overrides = {}) {
	const env = overrides.env || process.env;
	const log = overrides.logger || createLogger('relay');
	const mode = overrides.mode || config.mode || 'dry-run';

	const target = buildTarget(config.target, env);
	const wallets = await buildWallets(config.wallets, target, env);
	const sources = buildSources(config.source ?? config.sources, config, env);
	const store = config.store?.dir ? await createFileStore(config.store.dir) : createMemoryStore();

	const relay = createRelay({
		sources, target, wallets, store, log, mode,
		confirm: overrides.confirm,
		rules: config.rules,
		mapper: config.mapper,
		budget: config.budget,
		logger: log,
		avoidSymbolCollision: config.avoidSymbolCollision !== false,
		onLaunch: overrides.onLaunch,
		onSkip: overrides.onSkip,
		onFailure: overrides.onFailure,
	});

	return { relay, target, wallets, sources, store, log, mode };
}

function buildTarget(cfg = {}, env) {
	const type = cfg.type || 'pairfund';
	switch (type) {
		case 'pairfund':
			return createPairFundTarget({
				rpcUrl: cfg.rpcUrl || env.LAUNCH_RELAY_RPC_URL || undefined,
				launchpad: cfg.launchpad,
				apiBase: cfg.apiBase,
				marketSelector: cfg.markets,
				deadlineSeconds: cfg.deadlineSeconds,
				creatorFeeRecipient: cfg.creatorFeeRecipient,
			});
		case 'pumpfun':
			return createPumpFunTarget({
				rpcUrl: cfg.rpcUrl || env.LAUNCH_RELAY_SOLANA_RPC_URL || undefined,
				initialBuySol: cfg.initialBuySol,
				slippageBps: cfg.slippageBps,
				priorityFeeSol: cfg.priorityFeeSol,
			});
		default:
			throw new Error(`unknown target type "${type}" (expected pairfund or pumpfun)`);
	}
}

async function buildWallets(cfg = {}, target, env) {
	const type = cfg.type || (target.chain === 'solana' ? 'solana' : 'evm');
	if (type === 'solana') {
		return createSolanaWalletPool({
			rpcUrl: cfg.rpcUrl || env.LAUNCH_RELAY_SOLANA_RPC_URL || undefined,
			secretKeys: splitList(env[cfg.keysEnv || 'LAUNCH_RELAY_SOLANA_KEYS']),
			keyFile: cfg.keyFile || env.LAUNCH_RELAY_SOLANA_KEYFILE || undefined,
			strategy: cfg.strategy,
		});
	}
	return createEvmWalletPool({
		chain: target.viemChain,
		rpcUrl: cfg.rpcUrl || env.LAUNCH_RELAY_RPC_URL || undefined,
		mnemonic: env[cfg.mnemonicEnv || 'LAUNCH_RELAY_MNEMONIC'] || undefined,
		count: cfg.count,
		startIndex: cfg.startIndex,
		privateKeys: splitList(env[cfg.keysEnv || 'LAUNCH_RELAY_EVM_KEYS']),
		keyFile: cfg.keyFile || env.LAUNCH_RELAY_KEYFILE || undefined,
		strategy: cfg.strategy,
	});
}

function buildSources(cfg, config, env) {
	const list = Array.isArray(cfg) ? cfg : [cfg || {}];
	return list.map((entry) => {
		const type = entry.type || 'pumpfun-graduations';
		switch (type) {
			case 'pumpfun-graduations':
				return createPumpFunGraduationSource({
					stream: entry.stream,
					pumpPortal: entry.pumpPortal,
					backfill: entry.backfill,
					baseUrl: entry.baseUrl || env.LAUNCH_RELAY_FEED_BASE || undefined,
					pollIntervalMs: entry.pollIntervalMs,
					backfillLimit: entry.backfillLimit,
					emitBacklog: entry.emitBacklog,
				});
			case 'manual':
				return createManualSource(entry.entries || config.entries || []);
			default:
				throw new Error(`unknown source type "${type}" (expected pumpfun-graduations or manual)`);
		}
	});
}

const splitList = (value) =>
	String(value || '')
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);

function mergeDeep(base, patch) {
	for (const [key, value] of Object.entries(patch || {})) {
		if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
			base[key] = mergeDeep(base[key], value);
		} else {
			base[key] = value;
		}
	}
	return base;
}
