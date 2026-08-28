// launch-relay: watch one venue, launch on another, from a pool of wallets.
//
//   import { presets } from 'launch-relay';
//
//   const { relay } = await presets.pumpfunToPairfund({
//     mnemonic: process.env.LAUNCH_RELAY_MNEMONIC,
//     rules: { minMarketCapUsd: 40_000 },
//   });
//   relay.start();
//
// Every piece the preset wires is exported here and swappable: bring a
// different source, a different launchpad, a different wallet pool, or a
// different store, and the engine does not change. See README.md for the guide
// and src/types.js for the adapter contracts.

export { createRelay } from './engine.js';
export { buildRelay, loadConfig, DEFAULT_CONFIG } from './config.js';
export { createLogger, nullLogger } from './log.js';

export { createRules, DEFAULT_RULES } from './rules.js';
export { createMapper, render, DEFAULT_TEMPLATES } from './mapping.js';
export { createBudget, DEFAULT_BUDGET } from './budget.js';
export { sanitizeName, sanitizeSymbol, sanitizeDescription, uniqueSymbol } from './symbols.js';

export { createPumpFunGraduationSource, normalizeGraduation, enrichSignal } from './sources/pumpfun-graduations.js';
export { createManualSource } from './sources/manual.js';

export { createPairFundTarget } from './targets/pairfund/index.js';
export { createPairFundApi, PAIR_API_BASE } from './targets/pairfund/api.js';
export { createMarketSelector, scoreMarkets, evenWeights, MARKET_THEMES } from './targets/pairfund/markets.js';
export { robinhoodChain, ROBINHOOD_CHAIN_ID } from './targets/pairfund/chain.js';
export { PAIR_LAUNCHPAD_V5, launchpadAbi } from './targets/pairfund/abi.js';
export { createPumpFunTarget } from './targets/pumpfun.js';

export { createEvmWalletPool } from './wallets/evm.js';
export { createSolanaWalletPool } from './wallets/solana.js';
export { pickWallet, STRATEGIES } from './wallets/rotation.js';

export { createFileStore } from './store/file.js';
export { createMemoryStore } from './store/memory.js';

// ── analysis, money, and operations ──────────────────────────────────────────
export { backtest, fetchGraduationHistory, toHistoricalSignal, UNBACKTESTABLE_RULES } from './backtest.js';
export { fetchClaimable, fetchPending, planClaims, executeClaims } from './targets/pairfund/fees.js';
export { PAIR_V4_LOCKER, lockerAbi } from './targets/pairfund/abi.js';
export { buildPortfolio, summarizeEconomics } from './positions.js';
export { planFunding, executeFunding } from './wallets/fund.js';
export { renderBacktest, renderPlan, renderPositions, renderFees, usd, pct } from './report.js';
export { createDashboard } from './tui.js';

// ── approvals and notifications ──────────────────────────────────────────────
export {
	createTelegramApproval, createTerminalApproval, createStandingApproval, requireAll,
} from './approvals.js';
export { createNotifier, buildTransports, createTelegramClient, createWebhookTransport } from './notify/index.js';

// ── shared plumbing ──────────────────────────────────────────────────────────
export { fetchImageBytes, fetchJson, isPrivateHost } from './http.js';

import { createRelay } from './engine.js';
import { createLogger } from './log.js';
import { createPumpFunGraduationSource } from './sources/pumpfun-graduations.js';
import { createPairFundTarget } from './targets/pairfund/index.js';
import { createEvmWalletPool } from './wallets/evm.js';
import { createFileStore } from './store/file.js';

/** Ready-made wirings. Each returns an unstarted relay. */
export const presets = {
	/**
	 * The headline flow: a coin bonds on pump.fun (Solana), and the relay
	 * launches a paired token for it on PAIR (Robinhood Chain), rotating
	 * through a pool of wallets derived from one seed phrase.
	 *
	 * Defaults to dry-run. Pass `mode: 'live'` together with a `confirm`
	 * callback to let it spend.
	 *
	 * @param {object} opts
	 * @param {string} [opts.mnemonic]     Seed for the wallet pool.
	 * @param {string[]} [opts.privateKeys]
	 * @param {number} [opts.wallets]      Accounts to derive. Default 3.
	 * @param {'dry-run'|'live'} [opts.mode]
	 * @param {(plan: object) => Promise<boolean>} [opts.confirm]
	 * @param {object} [opts.rules]
	 * @param {object} [opts.mapper]
	 * @param {object} [opts.budget]
	 * @param {object} [opts.markets]      Market selection config for PAIR.
	 * @param {string} [opts.ledgerDir]    Default '.ledger'.
	 * @param {string} [opts.rpcUrl]
	 */
	async pumpfunToPairfund(opts = {}) {
		const log = opts.logger || createLogger('relay');
		const target = createPairFundTarget({ rpcUrl: opts.rpcUrl, marketSelector: opts.markets });
		const wallets = await createEvmWalletPool({
			chain: target.viemChain,
			rpcUrl: opts.rpcUrl,
			mnemonic: opts.mnemonic,
			privateKeys: opts.privateKeys,
			count: opts.wallets ?? 3,
			strategy: opts.strategy,
		});
		const store = await createFileStore(opts.ledgerDir || '.ledger');
		const source = createPumpFunGraduationSource(opts.source);

		const relay = createRelay({
			sources: [source],
			target,
			wallets,
			store,
			logger: log,
			mode: opts.mode || 'dry-run',
			confirm: opts.confirm,
			rules: opts.rules,
			mapper: opts.mapper,
			budget: opts.budget,
			onLaunch: opts.onLaunch,
			onSkip: opts.onSkip,
		});

		return { relay, target, wallets, source, store, log };
	},
};
