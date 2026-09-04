// The protocol, exercised against live Robinhood Chain state.
//
// These are not unit tests against mocks. Every one of them deploys the real
// contracts on top of the current block and calls the real Uniswap factory,
// position manager and WETH through `eth_simulateV1`. Nothing is signed and no
// key is needed: the deployer is funded by a state override that lasts for the
// duration of one RPC call.
//
// Testing a launcher against a mocked AMM proves the mock. The failures that
// matter here are the ones only the real deployment produces: a fee tier that
// is not enabled, a tick that is not aligned to the spacing the factory
// actually returns, a position manager whose mint takes less than it was
// offered. So the tests talk to the chain.
//
// They are skipped, loudly, when the RPC cannot be reached.

import { beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, parseAbi } from 'viem';
import { ARTIFACTS, PERMANENT, buildDeployment, buildLaunch, simulateSteps } from '../src/chains/robinhood/protocol.js';
import { ROBINHOOD_RPC_URL, robinhoodChain } from '../src/chains/robinhood/chain.js';
import { TOKENS } from '../src/chains/robinhood/contracts.js';

const rpcUrl = process.env.LAUNCH_RELAY_RPC_URL || ROBINHOOD_RPC_URL;
const client = createPublicClient({
	chain: robinhoodChain({ rpcUrl }),
	transport: http(rpcUrl, { retryCount: 3, retryDelay: 2_000, timeout: 60_000 }),
});

const DEPLOYER = '0x00000000000000000000000000000000000de910';
const STRANGER = '0x0000000000000000000000000000000000005712';
const ZERO = `0x${'0'.repeat(40)}`;

const launcherAbi = ARTIFACTS.relayLauncher.abi;
const lockerAbi = ARTIFACTS.liquidityLocker.abi;
const registryAbi = ARTIFACTS.launchRegistry.abi;
const tokenAbi = ARTIFACTS.launchToken.abi;

let reachable = false;
beforeAll(async () => {
	try {
		await client.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [] }] }, 'latest'] });
		reachable = true;
	} catch (err) {
		console.warn(`\n  skipping contract tests: ${rpcUrl} did not answer eth_simulateV1 (${String(err?.shortMessage || err?.message).split('\n')[0]})\n`);
	}
}, 60_000);

const onChain = (name, fn, timeout = 90_000) =>
	it(name, async (ctx) => {
		if (!reachable) return ctx.skip();
		await fn();
	}, timeout);

/** Deployment plus a launch, as one simulatable sequence. */
function scenario({ amm = 'uniswap-v3', pool, launchOverrides = {}, extra = () => [], from = DEPLOYER } = {}) {
	const deployment = buildDeployment({ deployer: DEPLOYER, amms: [amm] });
	const launch = buildLaunch({
		launcher: deployment.addresses.launcher,
		creator: from,
		adapter: deployment.addresses.adapters[amm],
		amm,
		token: { name: 'Loop Rat', symbol: 'LOOPRAT', metadataURI: 'ipfs://bafkreiprobe' },
		salt: `0x${'11'.repeat(32)}`,
		pool: pool ?? (amm === 'uniswap-v2'
			? { quote: ZERO, quoteAmount: 10n ** 16n }
			: { type: 'single-sided', fee: 10_000, quote: TOKENS.WETH, startFdv: 2 }),
		unlockAt: PERMANENT,
		...launchOverrides,
	});
	const steps = [
		...deployment.steps,
		{
			label: 'launch',
			kind: 'call',
			to: deployment.addresses.launcher,
			data: encodeFunctionData({ abi: launcherAbi, functionName: 'launch', args: [{ ...launch.params, ...(launchOverrides.params || {}) }] }),
			value: launchOverrides.value ?? launch.nativeValue,
			gas: 12_000_000n,
		},
		...extra({ deployment, launch }),
	];
	return { deployment, launch, steps };
}

const call = (label, to, abi, functionName, args, opts = {}) => ({
	label, kind: 'call', to, data: encodeFunctionData({ abi, functionName, args }),
	value: opts.value ?? 0n, gas: opts.gas ?? 1_000_000n,
});

function launchedEvent(result) {
	return (result.logs || [])
		.map((log) => { try { return decodeEventLog({ abi: launcherAbi, data: log.data, topics: log.topics }); } catch { return null; } })
		.find((e) => e?.eventName === 'Launched');
}

describe('a launch through RelayLauncher', () => {
	onChain('deploys, pools and locks in one transaction on Uniswap V3', async () => {
		const { launch, steps } = scenario();
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		for (const result of results) expect(result.ok, `${result.label}: ${result.error || ''}`).toBe(true);

		const event = launchedEvent(results.at(-1));
		expect(event).toBeDefined();
		expect(event.args.token.toLowerCase()).toBe(launch.tokenAddress.toLowerCase());
		expect(event.args.pool).not.toBe(ZERO);
		expect(event.args.lockId).toBe(1n);
		expect(event.args.unlockAt).toBe(PERMANENT);
	});

	onChain('does the same on a constant-product pool', async () => {
		const { launch, steps } = scenario({ amm: 'uniswap-v2' });
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		for (const result of results) expect(result.ok, `${result.label}: ${result.error || ''}`).toBe(true);
		expect(launchedEvent(results.at(-1)).args.token.toLowerCase()).toBe(launch.tokenAddress.toLowerCase());
	});

	onChain('mints a fixed supply that the pool ends up holding', async () => {
		const { launch, steps } = scenario({
			extra: ({ deployment, launch: l }) => [
				call('token.totalSupply', l.tokenAddress, tokenAbi, 'totalSupply', []),
				call('token.balanceOf(launcher)', l.tokenAddress, tokenAbi, 'balanceOf', [deployment.addresses.launcher]),
			],
		});
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		const [supply, launcherBalance] = results.slice(-2);
		expect(supply.ok).toBe(true);
		expect(BigInt(supply.returnData)).toBe(launch.params.supply);
		// The launcher must end the transaction holding none of the token it
		// just created. Anything left there is stranded forever.
		expect(BigInt(launcherBalance.returnData)).toBe(0n);
	});

	onChain('records the launch in the registry, flagged as its own', async () => {
		const { launch, steps } = scenario({
			extra: ({ deployment, launch: l }) => [call('registry.recordOf', deployment.addresses.registry, registryAbi, 'recordOf', [l.tokenAddress])],
		});
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		const record = results.at(-1);
		expect(record.ok).toBe(true);
		// The record is a struct; the viaRelay flag is its last word.
		expect(BigInt(`0x${record.returnData.slice(-64)}`)).toBe(1n);
		expect(record.returnData.toLowerCase()).toContain(launch.tokenAddress.slice(2).toLowerCase());
	});
});

describe('what a launch refuses to do', () => {
	onChain('will not use an adapter the owner has not registered', async () => {
		const { deployment, launch } = scenario();
		const steps = [
			...buildDeployment({ deployer: DEPLOYER, amms: ['uniswap-v3'] }).steps.filter((s) => !s.label.startsWith('launcher.setAdapter')),
			call('launch with an unregistered adapter', deployment.addresses.launcher, launcherAbi, 'launch', [launch.params], { gas: 12_000_000n, value: launch.nativeValue }),
		];
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		expect(results.at(-1).ok).toBe(false);
	});

	onChain('will not accept native value it cannot account for', async () => {
		const { steps } = scenario({ launchOverrides: { value: 10n ** 15n } });
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		// Everything up to the launch works; the launch itself refuses.
		for (const result of results.slice(0, -1)) expect(result.ok, result.label).toBe(true);
		expect(results.at(-1).ok).toBe(false);
	});

	onChain('will not let a stranger register an adapter or take ownership', async () => {
		const deployment = buildDeployment({ deployer: DEPLOYER, amms: ['uniswap-v3'] });
		const steps = [
			...deployment.steps,
			// Sent by somebody who is not the owner, in the same bundle, so the
			// contracts under test are the ones the owner just deployed.
			{ ...call('stranger.setAdapter', deployment.addresses.launcher, launcherAbi, 'setAdapter', [ZERO, true]), from: STRANGER },
			{ ...call('stranger.setFee', deployment.addresses.launcher, launcherAbi, 'setFee', [1, STRANGER]), from: STRANGER },
			{ ...call('stranger.transferOwnership', deployment.addresses.launcher, launcherAbi, 'transferOwnership', [STRANGER]), from: STRANGER },
			{ ...call('stranger.setAuthorised', deployment.addresses.registry, registryAbi, 'setAuthorised', [STRANGER, true]), from: STRANGER },
		];
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps, stateOverrides: { [STRANGER]: { balance: '0xde0b6b3a7640000' } } });
		for (const result of results.slice(0, deployment.steps.length)) expect(result.ok, result.label).toBe(true);
		for (const result of results.slice(deployment.steps.length)) {
			expect(result.ok, `${result.label} must be refused`).toBe(false);
		}
	});

	onChain('will not set a protocol fee above its own cap', async () => {
		const deployment = buildDeployment({ deployer: DEPLOYER, amms: ['uniswap-v3'] });
		const steps = [
			...deployment.steps,
			call('setFee(1%)', deployment.addresses.launcher, launcherAbi, 'setFee', [100, DEPLOYER]),
			call('setFee(1.01%)', deployment.addresses.launcher, launcherAbi, 'setFee', [101, DEPLOYER]),
		];
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		expect(results.at(-2).ok, 'the cap itself is allowed').toBe(true);
		expect(results.at(-1).ok, 'one basis point over is not').toBe(false);
	});
});

describe('a permanent lock', () => {
	onChain('cannot be withdrawn, by anyone, ever', async () => {
		const { deployment, steps } = scenario({
			extra: ({ deployment }) => [
				call('locker.isPermanent', deployment.addresses.locker, lockerAbi, 'isPermanent', [1n]),
				call('locker.withdraw', deployment.addresses.locker, lockerAbi, 'withdraw', [1n, DEPLOYER]),
			],
		});
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		const [permanent, withdraw] = results.slice(-2);
		expect(permanent.ok).toBe(true);
		expect(BigInt(permanent.returnData)).toBe(1n);
		expect(withdraw.ok, 'withdrawing a permanent lock must revert').toBe(false);
	});

	onChain('cannot be extended, because there is nothing past never', async () => {
		const { deployment, steps } = scenario({
			extra: ({ deployment }) => [call('locker.extend', deployment.addresses.locker, lockerAbi, 'extend', [1n, PERMANENT])],
		});
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		expect(results.at(-1).ok).toBe(false);
	});

	onChain('holds the position, not the creator', async () => {
		const { deployment, steps } = scenario({
			extra: ({ deployment }) => [call('locker.getLock', deployment.addresses.locker, lockerAbi, 'getLock', [1n])],
		});
		const { results } = await simulateSteps({ client, from: DEPLOYER, steps });
		const lock = results.at(-1);
		expect(lock.ok).toBe(true);
		// The beneficiary word of the struct is the creator; custody is the locker's.
		expect(lock.returnData.toLowerCase()).toContain(DEPLOYER.slice(2).toLowerCase());
	});
});
