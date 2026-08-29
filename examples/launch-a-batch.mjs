// Launch the same coin N times, by hand, through the real pipeline.
//
// The sibling of launch-one-coin.mjs, for when the thing you want minted is a
// run rather than a single token. Everything still goes through the engine, so
// the batch is rules-checked, budget-capped, priced and written to the same
// ledger a relayed launch is: this is not a side door around the caps.
//
// Three differences from the single-coin example, all forced by the shape of a
// batch. Every entry carries its own id, because the engine dedupes on it and
// ten identical specs would otherwise collapse into one launch. Symbol
// collision avoidance is off, because a batch of ten is meant to be ten of the
// same ticker rather than PAIR, PAIR2, PAIR3. And the artwork is uploaded once
// up front and the hosted URL reused, instead of paying for N uploads of the
// same bytes.
//
//   node examples/launch-a-batch.mjs --image ./logo.webp --symbol PAIR \
//     --name PAIR --count 10 --description "..." \
//     --website https://example.com --twitter https://x.com/example --yes
//
// Requires LAUNCH_RELAY_EVM_KEYS and a funded wallet. It spends real money,
// and without --yes it stops after pricing the first launch.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { formatEther } from 'viem';
import { createRelay } from '../src/engine.js';
import { createManualSource } from '../src/sources/manual.js';
import { createPairFundTarget } from '../src/targets/pairfund/index.js';
import { createEvmWalletPool } from '../src/wallets/evm.js';
import { createFileStore } from '../src/store/file.js';
import { createLogger } from '../src/log.js';
import { renderPlan } from '../src/report.js';

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i === -1 || i === argv.length - 1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

const imagePath = flag('image');
const symbol = flag('symbol');
const name = flag('name', symbol);
const count = Number(flag('count', '1'));
const description = flag('description', '');
const website = flag('website') || null;
const twitter = flag('twitter') || null;
const telegram = flag('telegram') || null;
const live = has('yes');

if (!imagePath || !symbol || !Number.isInteger(count) || count < 1) {
	throw new Error('usage: --image <logo> --symbol SYM [--name N] --count N [--description D] [--website U] [--twitter U] [--yes]');
}

// The single-coin example hardcodes image/png. A batch is worth getting right:
// uploading a webp under a png content type is how artwork silently 400s.
const MIME = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
const contentType = MIME[extname(imagePath).toLowerCase()];
if (!contentType) throw new Error(`unsupported artwork type "${extname(imagePath)}"`);

// High enough that the shared relay ledger's running daily total never
// refuses the batch. See the budget block below for why.
const BATCH_COUNTER_CEILING = 100_000;

const log = createLogger('batch');
// An operator naming the market wants exactly that market, so a pinned symbol
// becomes the whole fallback list and the count caps how many pools back the
// token. Left unset, the thematic selector picks from the coin text as usual.
const market = flag('market');
const pools = Number(flag('pools', market ? '1' : '2'));
const target = createPairFundTarget({
	marketSelector: {
		strategy: 'thematic',
		count: pools,
		...(market ? { fallback: market.split(',').map((m) => m.trim().toUpperCase()) } : {}),
	},
});

const bytes = readFileSync(imagePath);
const imageUrl = await target.api.uploadImage(bytes, contentType);
log.info(`logo hosted at ${imageUrl} (${(bytes.length / 1024).toFixed(0)}KB ${contentType})`);

const wallets = await createEvmWalletPool({
	chain: target.viemChain,
	privateKeys: (process.env.LAUNCH_RELAY_EVM_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean),
});
const wallet = (await wallets.list())[0];
log.info(`wallet ${wallet.address} holds ${formatEther(await wallet.balance())} ETH`);

const entries = Array.from({ length: count }, (_, i) => ({
	id: `manual:${symbol}:${Date.now()}:${i + 1}`,
	name,
	symbol,
	description,
	imageUrl,
	links: { website, twitter, telegram },
}));

let done = 0;
const launched = [];

const relay = createRelay({
	sources: [createManualSource(entries)],
	target,
	wallets,
	store: await createFileStore('.ledger-live'),
	logger: log,
	mode: 'live',
	rules: { kinds: ['manual'], maxSignalAgeSeconds: null, requireImage: true },
	mapper: { attributionTemplate: null, carryImage: true, carryLinks: true },
	// A batch of identical tickers is the point, not an accident to be renamed
	// around.
	avoidSymbolCollision: false,
	// The count is itself the cap here: an operator asked for exactly N. The
	// per-launch ceiling and the wallet reserve stay as the real guards, and
	// they are what stops the batch when the wallet runs dry. Per-day counters
	// are deliberately not the limit, because this ledger is shared with the
	// relay and its running total would refuse a hand-run batch outright.
	budget: {
		maxLaunchesPerHour: BATCH_COUNTER_CEILING,
		maxLaunchesPerDay: BATCH_COUNTER_CEILING,
		maxLaunchesPerWalletPerDay: BATCH_COUNTER_CEILING,
		cooldownMs: 0, walletCooldownMs: 0,
		maxSpendPerLaunch: '0.003', maxSpendPerDay: '1.0', minWalletReserve: '0.0002',
	},
	confirm: async (plan) => {
		process.stdout.write(`\n${renderPlan(plan)}\n`);
		if (!live) {
			process.stdout.write('\nstopping: re-run with --yes to sign and send.\n');
			return false;
		}
		return true;
	},
	onLaunch: ({ result }) => {
		done += 1;
		launched.push(result);
		process.stdout.write(`\n[${done}/${count}] LAUNCHED\n  tx    ${result.explorerUrl}\n  token ${result.tokenAddress}\n  page  ${result.url}\n`);
	},
	onSkip: ({ reason, reasons }) => log.warn(`skipped: ${reason} (${(reasons || []).join('; ')})`),
	onFailure: ({ error }) => log.error(`failed: ${error}`),
});

await relay.runOnce();
relay.stop();

process.stdout.write(`\nlaunched ${launched.length}/${count}\n`);
for (const r of launched) process.stdout.write(`  ${r.tokenAddress}  ${r.url}\n`);
process.stdout.write(`balance ${formatEther(await wallet.balance())} ETH\n`);
