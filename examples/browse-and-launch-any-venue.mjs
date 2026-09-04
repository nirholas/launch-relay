// Pick a Robinhood Chain venue, price a launch on it, and see exactly what
// would be sent.
//
//   node examples/browse-and-launch-any-venue.mjs                 # list venues
//   node examples/browse-and-launch-any-venue.mjs virtuals        # price one
//
// Read-only. It builds and simulates a live launch plan and prints it; nothing
// is signed, and no argument to this script can make it sign. To actually
// launch, use `launch-relay launch --venue <id> --live` or wire the target
// into a relay.
//
// Needs a key only so the plan can be priced from a real address:
// LAUNCH_RELAY_EVM_KEYS, or LAUNCH_RELAY_MNEMONIC.

import { formatEther } from 'viem';
import { createRobinhoodVenueTarget } from '../src/chains/robinhood/target.js';
import { describeBindings } from '../src/chains/robinhood/venues/descriptor.js';
import { findVenue, listVenues } from '../src/chains/robinhood/venues/index.js';
import { createEvmWalletPool } from '../src/wallets/evm.js';
import { createLogger } from '../src/log.js';

const log = createLogger('venues');
const wanted = process.argv[2];

if (!wanted) {
	for (const venue of listVenues({ usable: true })) {
		console.log(`${venue.id.padEnd(24)} ${String(venue.observed.launches).padStart(5)} launches  ${venue.label || ''}`);
	}
	console.log(`\npick one: node examples/browse-and-launch-any-venue.mjs <id>`);
	process.exit(0);
}

const venue = findVenue(wanted);
if (!venue) throw new Error(`no venue "${wanted}"; run this script with no arguments to list them`);
if (!venue.usable) throw new Error(`${venue.id} is catalogued but not launchable: ${venue.reason}`);

console.log(`\n${venue.label || venue.id} at ${venue.address}`);
console.log(`  ${venue.launch.signature}`);
console.log(`  anchored on ${venue.evidence.txHash}, which launched ${venue.evidence.symbol}`);
for (const line of describeBindings(venue)) console.log(`  ${line}`);

const target = createRobinhoodVenueTarget({ venue: venue.id });
const health = await target.health();
console.log(`\nhealth: ${health.ok ? 'ok' : 'FAIL'} ${health.detail}`);
if (!health.ok) process.exit(1);

const wallets = await createEvmWalletPool({
	chain: target.viemChain,
	mnemonic: process.env.LAUNCH_RELAY_MNEMONIC,
	privateKeys: (process.env.LAUNCH_RELAY_EVM_KEYS || '').split(/[,\s]+/).filter(Boolean),
	count: 1,
});
const wallet = wallets.list()[0];
if (!wallet) throw new Error('set LAUNCH_RELAY_MNEMONIC or LAUNCH_RELAY_EVM_KEYS so the plan can be priced');

const spec = {
	name: 'Loop Rat',
	symbol: 'LOOPRAT',
	description: 'an agent that keeps going',
	imageUrl: 'https://raw.githubusercontent.com/nirholas/launch-relay/main/.assets/pair-logo.webp',
	links: { twitter: null, telegram: null, website: null },
	origin: { source: 'example', chain: 'none', signalId: 'example' },
};

// dryRun: false builds the plan the live path would build, including a real
// simulation against the venue, and still signs nothing.
const plan = await target.plan(spec, { wallet, log, dryRun: false });
console.log(`\n${plan.summary.join('\n')}`);
for (const warning of plan.warnings) console.log(`  ! ${warning}`);
console.log(`\ntotal cost if sent: ${formatEther(plan.cost.totalBase)} ETH. Nothing was signed.`);
