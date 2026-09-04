#!/usr/bin/env node
// Deploy the Relay protocol to Robinhood Chain.
//
//   npm run contracts:deploy -- --dry-run        simulate, print, write nothing
//   npm run contracts:deploy -- --confirm        actually send it
//
// This spends real money, so the default is a dry run and the live path needs
// two keys turned at once: `--confirm` on the command line, and a key in
// LAUNCH_RELAY_DEPLOY_KEY. Neither on its own does anything.
//
// A dry run is not a weaker version of the deploy. It runs the identical
// sequence through `eth_simulateV1` against the current block, reports the gas
// each step costs and the addresses each will land at, and fails on anything
// the live run would fail on. The only difference is that nothing is signed.

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildDeployment, simulateSteps } from '../src/chains/robinhood/protocol.js';
import { ROBINHOOD_RPC_URL, robinhoodChain, txUrl } from '../src/chains/robinhood/chain.js';
import deployments from '../src/chains/robinhood/deployments.json' with { type: 'json' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYMENTS = join(root, 'src/chains/robinhood/deployments.json');

const argv = parseArgs(process.argv.slice(2));
const live = Boolean(argv.confirm);
const rpcUrl = argv.rpc || process.env.LAUNCH_RELAY_RPC_URL || ROBINHOOD_RPC_URL;
const chain = robinhoodChain({ rpcUrl });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 6, retryDelay: 2_000, timeout: 60_000 }) });

const key = process.env.LAUNCH_RELAY_DEPLOY_KEY;
if (live && !key) {
	console.error('--confirm needs LAUNCH_RELAY_DEPLOY_KEY set to the deploying private key.');
	process.exit(1);
}

const account = key ? privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`) : null;
const deployer = argv.deployer || account?.address;
if (!deployer) {
	console.error('nothing to deploy from. Set LAUNCH_RELAY_DEPLOY_KEY, or pass --deployer <address> for a dry run.');
	process.exit(1);
}

const owner = argv.owner || deployer;
const feeCollector = argv['fee-collector'] || owner;
const amms = (argv.amms || 'uniswap-v2,uniswap-v3').split(',').map((s) => s.trim()).filter(Boolean);
const nonce = await publicClient.getTransactionCount({ address: deployer });

const { addresses, steps } = buildDeployment({ deployer, owner, feeCollector, amms, nonce });

console.log(`${live ? 'DEPLOYING' : 'dry run'} on ${chain.name} (chain ${chain.id}) via ${rpcUrl}`);
console.log(`deployer     ${deployer}  nonce ${nonce}`);
console.log(`owner        ${owner}`);
console.log(`fee collector ${feeCollector}`);
console.log(`adapters     ${amms.join(', ')}\n`);
console.log('addresses these transactions will produce:');
console.log(`  locker     ${addresses.locker}`);
console.log(`  registry   ${addresses.registry}`);
console.log(`  launcher   ${addresses.launcher}`);
for (const [id, address] of Object.entries(addresses.adapters)) console.log(`  ${id.padEnd(10)} ${address}`);
console.log('');

// Always simulate, including before a live run. A deploy that would revert
// halfway leaves a half-built protocol and a bill.
const simulation = await simulateSteps({ client: publicClient, from: deployer, steps });
let totalGas = 0n;
for (const result of simulation.results) {
	totalGas += BigInt(result.gasUsed);
	const size = result.codeSize ? `  ${result.codeSize.toLocaleString('en-US')} bytes` : '';
	console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.label.padEnd(30)} ${result.gasUsed.toLocaleString('en-US').padStart(10)} gas${size}${result.ok ? '' : `  ${result.error || 'reverted'}`}`);
}
if (!simulation.ok) {
	console.error('\nthe simulation failed; nothing was sent');
	process.exit(1);
}

const gasPrice = await publicClient.getGasPrice();
console.log(`\ntotal gas    ${totalGas.toLocaleString('en-US')}`);
console.log(`at ${formatEther(gasPrice * 10n ** 9n)} ETH/Ggas, roughly ${formatEther(totalGas * gasPrice)} ETH`);

if (!live) {
	console.log('\nDry run. Nothing was signed. Re-run with --confirm and LAUNCH_RELAY_DEPLOY_KEY to deploy.');
	process.exit(0);
}

const balance = await publicClient.getBalance({ address: deployer });
const needed = totalGas * gasPrice * 12n / 10n;
if (balance < needed) {
	console.error(`\n${deployer} holds ${formatEther(balance)} ETH; this deploy needs about ${formatEther(needed)} ETH including headroom.`);
	process.exit(1);
}

const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 6, retryDelay: 2_000 }) });
console.log('\nsending:');
const transactions = [];
for (const step of steps) {
	const hash = await walletClient.sendTransaction({
		to: step.to ?? null,
		data: step.data,
		value: step.value ?? 0n,
		gas: step.gas,
	});
	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	transactions.push({ label: step.label, hash, status: receipt.status });
	console.log(`  ${receipt.status === 'success' ? 'ok  ' : 'FAIL'}  ${step.label.padEnd(30)} ${txUrl(hash)}`);
	if (receipt.status !== 'success') {
		console.error('\na step reverted on chain; the protocol is half-deployed and the record below is incomplete');
		break;
	}
}

const record = {
	...deployments,
	chains: {
		...deployments.chains,
		[String(chain.id)]: {
			chain: chain.name,
			deployedAt: new Date().toISOString(),
			deployer,
			owner,
			feeCollector,
			locker: addresses.locker,
			registry: addresses.registry,
			launcher: addresses.launcher,
			adapters: addresses.adapters,
			transactions: transactions.map((t) => ({ label: t.label, hash: t.hash })),
		},
	},
};
await writeFile(DEPLOYMENTS, `${JSON.stringify(record, null, '\t')}\n`);
console.log('\nwrote src/chains/robinhood/deployments.json. Commit it: the library, the CLI and the website all read it.');

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
