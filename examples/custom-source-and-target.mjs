// Everything is an adapter.
//
// This example replaces both ends of the relay: a source that watches
// something other than pump.fun, and a target that launches somewhere other
// than PAIR. The engine, the rules, the wallet rotation, the budget, and the
// ledger are unchanged, because none of them know what a launchpad is.
//
//   node examples/custom-source-and-target.mjs

import { createRelay, createMemoryStore } from 'launch-relay';

// A source only has to produce Signals. Implement `start` for a push feed
// (websocket, webhook) or `poll` for anything you can list on an interval.
const trendingSource = {
	id: 'my-trending-feed',
	chain: 'somechain',
	pollIntervalMs: 30_000,
	async poll() {
		const res = await fetch('https://pair.fund/api/stats/trending');
		const tokens = await res.json();
		return tokens.slice(0, 5).map((t) => ({
			id: `trending:${t.address}`,
			source: 'my-trending-feed',
			kind: 'trending',
			chain: 'robinhood',
			at: Date.now(),
			address: t.address,
			name: t.name,
			symbol: t.symbol,
			description: `Trending on PAIR: ${t.name}`,
			imageUrl: t.imageUrl || null,
			links: {},
			metrics: { marketCapUsd: Number(t.marketCapUsd) || null },
			raw: t,
		}));
	},
};

// A target has to price a launch (`plan`) and send it (`execute`). Keeping
// those separate is what lets the engine show a human the exact cost of the
// exact transaction before anything is signed.
const printTarget = {
	id: 'print-only',
	chain: 'nowhere',
	chainId: 0,
	nativeSymbol: 'ETH',
	nativeDecimals: 18,
	async plan(spec, { wallet }) {
		return {
			target: 'print-only',
			chain: 'nowhere',
			chainId: 0,
			spec,
			wallet: wallet.address,
			contract: '0xdeadbeef',
			cost: { nativeSymbol: 'ETH', feeNative: '0', gasNative: '0', totalNative: '0', totalBase: 0n },
			warnings: [],
			call: {},
			summary: [`would launch ${spec.name} (${spec.symbol}) from ${wallet.address}`],
		};
	},
	async execute(plan) {
		console.log(plan.summary.join('\n'));
		return { ok: true, txHash: 'printed', tokenAddress: null, url: null };
	},
};

// A wallet pool is three methods. This one is a single fake key, which is
// enough to prove the pipeline without touching a chain.
const wallets = {
	chain: 'nowhere',
	list: () => [{ address: '0xabc', label: 'fake-0', signer: null, balance: async () => 10n ** 18n }],
	async pick() {
		return this.list()[0];
	},
	markUsed() {},
};

const relay = createRelay({
	sources: [trendingSource],
	target: printTarget,
	wallets,
	store: createMemoryStore(),
	rules: { kinds: ['trending'], requireImage: false, maxSignalAgeSeconds: null },
	mapper: { nameTemplate: 'Mirror of {{name}}', symbolTemplate: 'm{{symbol}}' },
	mode: 'live',
	confirm: async () => true,
});

const history = await relay.runOnce();
console.log(`\n${history.length} record(s) written`);
