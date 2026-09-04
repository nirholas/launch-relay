#!/usr/bin/env node
// Deploy the whole protocol and launch a coin through it, against live
// Robinhood Chain state, without spending anything.
//
//   npm run contracts:simulate
//   npm run contracts:simulate -- --amm uniswap-v2 --quote-amount 0.01
//   npm run contracts:simulate -- --fee 3000 --start-fdv 5
//
// Robinhood Chain's RPC serves `eth_simulateV1`, which executes a sequence of
// transactions on top of the current block and returns what each one did. That
// is the difference between testing these contracts against mocks and testing
// them against the deployment they will really run on: the factory, the
// position manager, the enabled fee tiers and the WETH everyone actually
// trades are the ones in the simulation.
//
// Nothing is signed and no key is needed. The deployer is funded by a state
// override that exists for the duration of the call.

import { createPublicClient, decodeEventLog, encodeFunctionData, formatEther, http } from 'viem';
import { ADAPTERS, ARTIFACTS, PERMANENT, buildDeployment, buildLaunch, simulateSteps } from '../src/chains/robinhood/protocol.js';
import { ROBINHOOD_RPC_URL, robinhoodChain } from '../src/chains/robinhood/chain.js';
import { TOKENS } from '../src/chains/robinhood/contracts.js';

const argv = parseArgs(process.argv.slice(2));
const amm = argv.amm || 'uniswap-v3';
if (!ADAPTERS[amm]) throw new Error(`--amm must be one of ${Object.keys(ADAPTERS).join(', ')}`);

const rpcUrl = argv.rpc || process.env.LAUNCH_RELAY_RPC_URL || ROBINHOOD_RPC_URL;
const client = createPublicClient({
	chain: robinhoodChain({ rpcUrl }),
	transport: http(rpcUrl, { retryCount: 6, retryDelay: 2_000, timeout: 60_000 }),
});

/** A deployer with no key, funded only inside the simulation. */
const DEPLOYER = '0x00000000000000000000000000000000000de910';
const FEE_COLLECTOR = '0x000000000000000000000000000000000000Fee5';

const head = await client.getBlockNumber();
console.log(`simulating on Robinhood Chain at block ${head} via ${rpcUrl}\n`);

const deployment = buildDeployment({ deployer: DEPLOYER, feeCollector: FEE_COLLECTOR, amms: [amm] });
const launch = buildLaunch({
	launcher: deployment.addresses.launcher,
	creator: DEPLOYER,
	adapter: deployment.addresses.adapters[amm],
	amm,
	token: { name: 'Loop Rat', symbol: 'LOOPRAT', metadataURI: 'ipfs://bafkreiprobe' },
	salt: `0x${'11'.repeat(32)}`,
	pool: {
		type: argv['pool-type'] || 'single-sided',
		fee: argv.fee ? Number(argv.fee) : undefined,
		startFdv: argv['start-fdv'] ? Number(argv['start-fdv']) : amm === 'uniswap-v3' ? 2 : undefined,
		quote: amm === 'uniswap-v2' ? `0x${'0'.repeat(40)}` : TOKENS.WETH,
		quoteAmount: amm === 'uniswap-v2' || argv['quote-amount']
			? BigInt(Math.round(Number(argv['quote-amount'] ?? 0.01) * 1e18))
			: 0n,
	},
	unlockAt: PERMANENT,
});

const steps = [
	...deployment.steps,
	{
		label: 'launcher.launch(...)',
		kind: 'call',
		to: deployment.addresses.launcher,
		data: encodeFunctionData({ abi: ARTIFACTS.relayLauncher.abi, functionName: 'launch', args: [launch.params] }),
		value: launch.nativeValue,
		gas: 12_000_000n,
	},
];

const { ok, gasUsed, results } = await simulateSteps({ client, from: DEPLOYER, steps });

for (const result of results) {
	const size = result.codeSize ? `  ${result.codeSize.toLocaleString('en-US')} bytes on chain` : '';
	const why = result.ok ? '' : `  ${result.error || 'reverted'}${result.revertData ? ` ${result.revertData.slice(0, 10)}` : ''}`;
	console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.label.padEnd(30)} ${result.gasUsed.toLocaleString('en-US').padStart(10)} gas${size}${why}`);
}

if (ok) {
	const event = (results.at(-1).logs || [])
		.map((log) => { try { return decodeEventLog({ abi: ARTIFACTS.relayLauncher.abi, data: log.data, topics: log.topics }); } catch { return null; } })
		.find((e) => e?.eventName === 'Launched');

	console.log(`\npool         ${launch.describe}`);
	if (launch.nativeValue) console.log(`deposit      ${formatEther(launch.nativeValue)} ETH`);
	if (event) {
		console.log(`token        ${event.args.token}`);
		console.log(`pool address ${event.args.pool}`);
		console.log(`lock         id ${event.args.lockId}, ${event.args.unlockAt === PERMANENT ? 'permanent' : `until ${new Date(Number(event.args.unlockAt) * 1000).toISOString()}`}`);
		console.log(`supply       ${(event.args.supplyToPool / 10n ** 18n).toLocaleString('en-US')} into the pool`);

		// The address a caller is shown before they sign has to be the address
		// they get. A mismatch here means predictToken is lying.
		if (event.args.token.toLowerCase() !== launch.tokenAddress.toLowerCase()) {
			console.log(`\nFAIL  predicted ${launch.tokenAddress} but launched ${event.args.token}`);
			process.exit(1);
		}
		console.log(`\naddress prediction matched before the launch ran: ${launch.tokenAddress}`);
	}
	console.log(`total gas    ${gasUsed.toLocaleString('en-US')}`);
}

console.log(ok ? '\nthe whole protocol deploys and launches against live chain state' : '\nsimulation failed');
process.exit(ok ? 0 : 1);

function parseArgs(args) {
	const out = {};
	for (let i = 0; i < args.length; i++) {
		if (!args[i].startsWith('--')) continue;
		const key = args[i].slice(2);
		const next = args[i + 1];
		if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
	}
	return out;
}
