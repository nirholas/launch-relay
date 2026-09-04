// Launch with no launchpad: deploy a fixed-supply token and open its pool
// yourself, on the AMM, quote asset, fee tier and shape you choose.
//
//   node examples/launch-your-own-pool.mjs
//
// Read-only. It prices the whole flow, including a real gas estimate for the
// deployment, and prints it. Nothing is signed.
//
// The configuration below is the interesting part: a single-sided V3 position
// puts the entire supply up for sale from the starting valuation upward and
// needs no quote capital at all. Change `poolType` to 'full-range' and set
// `quoteAmount` for a conventional two-sided pool instead.

import { formatEther } from 'viem';
import { createPoolLaunchTarget } from '../src/chains/robinhood/amm/pool-target.js';
import { createEvmWalletPool } from '../src/wallets/evm.js';
import { createLogger } from '../src/log.js';

const log = createLogger('pool');

const target = createPoolLaunchTarget({
	amm: 'uniswap-v3',
	quote: 'WETH',
	poolType: 'single-sided',
	fee: 10_000,          // 1%
	supply: 1_000_000_000,
	startFdv: 2,          // the whole supply opens valued at 2 WETH
	rangeMultiple: 1000,  // offered for sale up to 1000x the start price
});

const health = await target.health();
console.log(`${health.ok ? 'ok' : 'FAIL'}  ${health.detail}`);
if (!health.ok) process.exit(1);

const wallets = await createEvmWalletPool({
	chain: target.viemChain,
	mnemonic: process.env.LAUNCH_RELAY_MNEMONIC,
	privateKeys: (process.env.LAUNCH_RELAY_EVM_KEYS || '').split(/[,\s]+/).filter(Boolean),
	count: 1,
});
const wallet = wallets.list()[0];
if (!wallet) throw new Error('set LAUNCH_RELAY_MNEMONIC or LAUNCH_RELAY_EVM_KEYS so the plan can be priced');

const plan = await target.plan({
	name: 'Loop Rat',
	symbol: 'LOOPRAT',
	description: 'an agent that keeps going',
	imageUrl: null,
	links: {},
	origin: { source: 'example', chain: 'none', signalId: 'example' },
}, { wallet, log, dryRun: false });

console.log(`\n${plan.summary.join('\n')}`);
for (const warning of plan.warnings) console.log(`  ! ${warning}`);
console.log(`\ntoken would deploy to ${plan.call.token}`);
console.log(`pool: ${plan.pool.poolType} ${plan.pool.amm}, token0 ${plan.pool.token0}, token1 ${plan.pool.token1}`);
console.log(`ceiling if sent: ${formatEther(plan.cost.totalBase)} ETH. Nothing was signed.`);
