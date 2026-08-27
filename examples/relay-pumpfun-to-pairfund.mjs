// Watch pump.fun for coins that bond, launch a paired token for each one on
// PAIR, rotating through three wallets derived from one seed phrase.
//
//   LAUNCH_RELAY_MNEMONIC="your twelve words" node examples/relay-pumpfun-to-pairfund.mjs
//
// This runs in dry-run mode: it does every read, every rule check, and prices
// every launch, but signs nothing. Read the ledger it writes to .ledger/ before
// you consider going live.

import { presets } from 'launch-relay';

const { relay } = await presets.pumpfunToPairfund({
	mnemonic: process.env.LAUNCH_RELAY_MNEMONIC,
	wallets: 3,

	// Which graduations are worth relaying.
	rules: {
		minMarketCapUsd: 40_000,
		maxSignalAgeSeconds: 300,
		requireImage: true,
		maxCreatorLaunches: 5,
		denyWords: ['rug', 'test'],
	},

	// How the relayed coin presents itself.
	mapper: {
		nameTemplate: '{{name}}',
		symbolTemplate: '{{symbol}}',
	},

	// Which Robinhood Stock Tokens each coin gets paired with. 'thematic' reads
	// the coin's own text: a Tesla joke lands in the TSLA pool, an AI coin in
	// NVDA, and anything with no clear theme falls back to the deepest markets.
	markets: { strategy: 'thematic', count: 2 },

	// What the relay is allowed to spend, even once it is live.
	budget: {
		maxLaunchesPerHour: 2,
		maxLaunchesPerDay: 8,
		maxSpendPerLaunch: '0.005',
		maxSpendPerDay: '0.03',
		minWalletReserve: '0.002',
	},

	onSkip: ({ signal, reason, details }) => {
		console.log(`skip ${signal.symbol}: ${reason} ${details?.join('; ') || ''}`);
	},
	onLaunch: ({ spec, result }) => {
		console.log(`launched ${spec.symbol} -> ${result.url}`);
	},
});

relay.start();
process.on('SIGINT', () => {
	relay.stop();
	process.exit(0);
});
