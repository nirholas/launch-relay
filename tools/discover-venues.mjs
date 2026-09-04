#!/usr/bin/env node
// Rebuild src/chains/robinhood/venues/catalog.json from Robinhood Chain.
//
//   npm run rhc:discover -- --blocks 300000
//   npm run rhc:discover -- --from 53000000 --to 53400000 --min-launches 2
//   npm run rhc:discover -- --cache .cache/scan.json     # reuse the last scan
//   npm run rhc:discover -- --simulate                   # also run a live launch on each
//
// Scans a block range for token mints, attributes each to the contract that
// produced it, resolves that contract's launch function, and learns a
// descriptor from one real launch per venue. Anything it cannot verify is
// written to the catalog too, marked unusable with the reason, because a venue
// the toolkit cannot drive is still a fact about the chain worth publishing.
//
// The scan is the slow part and public RPC rate limits are the reason. Point
// LAUNCH_RELAY_RPC_URL at a private endpoint and it finishes in a fraction of
// the time.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { ROBINHOOD_RPC_URL, robinhoodChain } from '../src/chains/robinhood/chain.js';
import { buildDescriptor, groupByLauncher, groupsFromTransactions, lookupSignatures, mergeGroups, probeDescriptor, scanMints } from '../src/chains/robinhood/discover.js';
import seeds from '../src/chains/robinhood/venues/seeds.json' with { type: 'json' };
import { labelVenues } from '../src/chains/robinhood/venues/labels.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(root, 'src/chains/robinhood/venues/catalog.json');

const argv = parseArgs(process.argv.slice(2));
const rpcUrl = argv.rpc || process.env.LAUNCH_RELAY_RPC_URL || ROBINHOOD_RPC_URL;
const client = createPublicClient({
	chain: robinhoodChain({ rpcUrl }),
	// The public endpoint answers 429 under any real load. Retrying with a
	// long backoff turns a scan that dies halfway into one that merely takes
	// longer, which for a catalog rebuild is the right trade.
	transport: http(rpcUrl, { retryCount: 10, retryDelay: 2_000, timeout: 60_000 }),
});

const progress = (msg) => process.stderr.write(`  ${msg}\n`);

const head = await client.getBlockNumber();
let toBlock = argv.to ? BigInt(argv.to) : head;
const blocks = BigInt(argv.blocks ?? 200_000);
let fromBlock = argv.from ? BigInt(argv.from) : toBlock - blocks + 1n;
const minLaunches = Number(argv['min-launches'] ?? 1);

// The scan is by far the slowest part, and iterating on how a descriptor is
// built should not mean re-reading the chain each time. A cache makes the
// second run of the day take seconds; it holds raw chain data only, so nothing
// downstream can be stale in a way that survives into the catalog.
const cachePath = argv.cache === true ? '.cache/rhc-scan.json' : argv.cache;
let scanned = cachePath ? await readCache(cachePath) : null;
let mints = [];

if (scanned) {
	console.error(`reusing the cached scan at ${cachePath}: ${scanned.length} launcher(s)`);
} else {
	console.error(`scanning Robinhood Chain blocks ${fromBlock}..${toBlock} via ${rpcUrl}`);
	mints = await scanMints({ client, fromBlock, toBlock, chunk: BigInt(argv.chunk ?? 2_000), onProgress: argv.quiet ? undefined : progress });
	console.error(`found ${mints.length} token mint(s)`);
	scanned = await groupByLauncher({ client, mints, onProgress: argv.quiet ? undefined : progress });
	console.error(`scan found ${scanned.length} launcher(s)`);
	if (cachePath) await writeCache(cachePath, { fromBlock, toBlock, mints: mints.length, groups: scanned });
}

// Venues whose launches predate the window are pinned by seed transactions,
// so a rebuild never quietly drops a venue that simply had a quiet week.
const seeded = argv['no-seeds'] ? [] : await groupsFromTransactions({ client, txHashes: seeds.transactions, onProgress: argv.quiet ? undefined : progress });
if (seeded.length) console.error(`seeds pinned ${seeded.length} launcher(s)`);

const groups = mergeGroups(scanned, seeded).filter((g) => g.launches.length >= minLaunches);
console.error(`grouped into ${groups.length} launcher(s) with >= ${minLaunches} launch(es)`);

const signatures = await lookupSignatures(groups.map((g) => g.selector));
const named = Object.values(signatures).filter(Boolean).length;
console.error(`resolved ${named}/${groups.length} selector(s) to a signature`);

const previous = await readCatalog();
const descriptors = [];
for (const group of groups) {
	const known = previous.get(`${group.address.toLowerCase()}:${group.selector}`);
	const descriptor = await buildDescriptor({
		client,
		group,
		signature: signatures[group.selector],
		id: known?.id,
		label: known?.label,
	});
	descriptors.push(descriptor);
	const state = descriptor.usable ? 'ok' : `unusable (${descriptor.reason})`;
	console.error(`  ${descriptor.address} ${group.selector} x${group.launches.length} ${state}`);
}

// Encoding correctly is not the same as launching, and knowing an argument's
// ABI type is not the same as knowing a launch may change it. Every usable
// venue is therefore driven against current state from a probe account funded
// only inside the simulation, one binding at a time, and anything the venue
// refuses is pruned back to being replayed. Pass --no-simulate to skip, at the
// cost of a catalog whose bindings are guesses rather than proofs.
if (!argv['no-simulate']) {
	console.error('\nsimulating a substituted launch on each usable venue');
	const reverts = new Set();
	for (let i = 0; i < descriptors.length; i++) {
		if (!descriptors[i].usable) continue;
		const probed = await probeDescriptor({ client, descriptor: descriptors[i] });
		probed.liveCheck = { ok: probed.probe?.ok ?? false, checkedAt: probed.probe?.at ?? new Date().toISOString(), reason: probed.reason };
		descriptors[i] = probed;
		for (const selector of [probed.probe?.revert, ...(probed.probe?.rejected || []).map((r) => r.revert)]) {
			if (selector) reverts.add(selector);
		}
		const selector = /\((0x[0-9a-f]{8})\)$/.exec(probed.liveCheck.reason || '')?.[1];
		if (selector) reverts.add(selector);
		const pruned = probed.probe?.rejected?.length ? `, ${probed.probe.rejected.length} field(s) pruned` : '';
		console.error(`  ${probed.id} ${probed.liveCheck.ok ? `launches (${probed.probe.accepted.join(', ')}${pruned})` : `reverts: ${probed.liveCheck.reason}`}`);
	}
	// Name the custom errors, so "reverts with 0xf2cef899" becomes
	// "reverts with TickerReserved" and a reader knows what to do about it.
	if (reverts.size) {
		const named = await lookupSignatures([...reverts]).catch(() => ({}));
		for (const descriptor of descriptors) {
			const selector = /\((0x[0-9a-f]{8})\)$/.exec(descriptor.liveCheck?.reason || '')?.[1];
			if (selector && named[selector]) {
				descriptor.liveCheck.revert = named[selector];
				descriptor.liveCheck.reason = descriptor.liveCheck.reason.replace(selector, named[selector]);
				if (descriptor.reason) descriptor.reason = descriptor.reason.replace(selector, named[selector]);
			}
			// A pruned field is more useful with the error that pruned it named:
			// "replayed because randomising it reverts with LaunchEconomicsMismatch"
			// tells a reader the field is a commitment, not a salt.
			for (const rejected of descriptor.probe?.rejected || []) {
				if (rejected.revert && named[rejected.revert]) rejected.revert = named[rejected.revert];
			}
		}
	}
}

const labelled = await labelVenues(descriptors, { fetchImpl: argv['no-labels'] ? null : fetch, onProgress: argv.quiet ? undefined : progress });
labelled.sort((a, b) => (b.observed?.launches ?? 0) - (a.observed?.launches ?? 0));

const catalog = {
	chainId: 4663,
	chain: 'Robinhood Chain',
	generatedAt: new Date().toISOString(),
	window: { fromBlock: Number(fromBlock), toBlock: Number(toBlock) },
	tokensScanned: scanned.reduce((sum, group) => sum + group.launches.length, 0),
	seedTransactions: argv['no-seeds'] ? 0 : seeds.transactions.length,
	venues: labelled,
};
await writeFile(CATALOG, `${JSON.stringify(catalog, null, '\t')}\n`);
const usable = labelled.filter((v) => v.usable).length;
const live = labelled.filter((v) => v.liveCheck?.ok).length;
console.error(`\nwrote ${labelled.length} venue(s) (${usable} usable${argv.simulate ? `, ${live} verified to launch right now` : ''}) to src/chains/robinhood/venues/catalog.json`);

async function readCache(path) {
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8'));
		// `--blocks` is relative to the head, so it names a different window
		// every minute and would invalidate the cache on every run. Asking to
		// reuse a scan means reusing the window it covered; pin --from/--to to
		// require an exact match instead.
		if (argv.from || argv.to) {
			if (BigInt(parsed.fromBlock) !== fromBlock || BigInt(parsed.toBlock) !== toBlock) {
				console.error(`cache covers blocks ${parsed.fromBlock}-${parsed.toBlock}, not the requested ${fromBlock}-${toBlock}; rescanning`);
				return null;
			}
		} else {
			fromBlock = BigInt(parsed.fromBlock);
			toBlock = BigInt(parsed.toBlock);
		}
		return parsed.groups.map((group) => ({
			...group,
			launches: group.launches.map((launch) => ({ ...launch, blockNumber: BigInt(launch.blockNumber), value: BigInt(launch.value) })),
		}));
	} catch {
		return null;
	}
}

async function writeCache(path, { fromBlock: from, toBlock: to, mints: count, groups }) {
	await mkdir(dirname(path), { recursive: true });
	const payload = {
		fromBlock: Number(from), toBlock: Number(to), mints: count,
		groups: groups.map((group) => ({
			...group,
			launches: group.launches.map((launch) => ({ ...launch, blockNumber: Number(launch.blockNumber), value: launch.value.toString() })),
		})),
	};
	await writeFile(path, JSON.stringify(payload));
	console.error(`cached the scan at ${path}`);
}

async function readCatalog() {
	try {
		const parsed = JSON.parse(await readFile(CATALOG, 'utf8'));
		return new Map((parsed.venues || []).map((v) => [`${v.address.toLowerCase()}:${v.selector}`, v]));
	} catch {
		return new Map();
	}
}

function parseArgs(args) {
	const out = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = args[i + 1];
		if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
	}
	return out;
}
