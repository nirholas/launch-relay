// Launch one specific coin, by hand, through the real pipeline.
//
// A relay picks its own coins. Sometimes you want to launch exactly one thing:
// a test, a named token, a coin whose signal the feed dropped. The manual
// source feeds it into the same mapper, market selector, target, budget, and
// ledger a relayed launch goes through, so this is not a side door.
//
//   node examples/launch-one-coin.mjs ./logo.png TEST "My Coin" "what it is"
//
// Requires LAUNCH_RELAY_EVM_KEYS and a funded wallet. It spends real money.

import { readFileSync } from 'node:fs';
import { createRelay } from './src/engine.js';
import { createManualSource } from './src/sources/manual.js';
import { createPairFundTarget } from './src/targets/pairfund/index.js';
import { createEvmWalletPool } from './src/wallets/evm.js';
import { createFileStore } from './src/store/file.js';
import { createLogger } from './src/log.js';
import { renderPlan } from './src/report.js';

const log = createLogger('test-launch');
const [logoPath, symbol = 'TEST', name = symbol, description = ''] = process.argv.slice(2);
if (!logoPath) throw new Error('usage: node launch-one-coin.mjs <logo.png> [symbol] [name] [description]');

const target = createPairFundTarget({ marketSelector: { strategy: 'thematic', count: 1 } });

// Host the logo on PAIR's image host first, so the metadata document written
// on chain points at artwork that is already there.
const imageUrl = await target.api.uploadImage(readFileSync(logoPath), 'image/png');
log.info(`logo hosted at ${imageUrl}`);

const wallets = await createEvmWalletPool({
	chain: target.viemChain,
	privateKeys: [process.env.LAUNCH_RELAY_EVM_KEYS],
});

const relay = createRelay({
	sources: [createManualSource([{
		id: `manual:${symbol}`,
		name,
		symbol,
		description: description || `${name}, launched with launch-relay.`,
		imageUrl,
		links: { website: 'https://github.com/nirholas/launch-relay', twitter: null, telegram: null },
	}])],
	target,
	wallets,
	store: await createFileStore('.ledger-live'),
	logger: log,
	mode: 'live',
	rules: { kinds: ['manual'], maxSignalAgeSeconds: null, requireImage: true },
	mapper: { attributionTemplate: null },
	budget: {
		maxLaunchesPerHour: 1, maxLaunchesPerDay: 1, maxLaunchesPerWalletPerDay: 1,
		cooldownMs: 0, walletCooldownMs: 0,
		maxSpendPerLaunch: '0.003', maxSpendPerDay: '0.003', minWalletReserve: '0.001',
	},
	confirm: async (plan) => {
		process.stdout.write(`\n${renderPlan(plan)}\n`);
		return true;
	},
	onLaunch: ({ result }) => {
		process.stdout.write(`\nLAUNCHED\n  tx    ${result.explorerUrl}\n  token ${result.tokenAddress}\n  page  ${result.url}\n`);
	},
});

await relay.runOnce();
relay.stop();
