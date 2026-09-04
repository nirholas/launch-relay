// The Relay protocol: what gets deployed, in what order, wired to what.
//
// One description of the deployment, used by three things that must not
// disagree: the simulator that proves it against live chain state, the test
// suite, and the script that actually deploys it. A deployment runbook that
// lives in prose drifts from the script that implements it; this one cannot,
// because there is only one of it.
//
// The order is load-bearing. The locker and the registry have no dependencies.
// The launcher takes both. The adapter takes the AMM's own addresses. Only
// then can the registry be told to trust the launcher and the launcher be told
// the adapter exists. Nothing here is optional and nothing can be reordered.

import { encodeAbiParameters, encodeDeployData, encodeFunctionData, encodePacked, getContractAddress, keccak256 } from 'viem';
import launchToken from './artifacts/launch-token.json' with { type: 'json' };
import liquidityLocker from './artifacts/liquidity-locker.json' with { type: 'json' };
import launchRegistry from './artifacts/launch-registry.json' with { type: 'json' };
import relayLauncher from './artifacts/relay-launcher.json' with { type: 'json' };
import uniswapV2Adapter from './artifacts/uniswap-v2-adapter.json' with { type: 'json' };
import uniswapV3Adapter from './artifacts/uniswap-v3-adapter.json' with { type: 'json' };
import { AMMS, TOKENS } from './contracts.js';
import { alignTick, encodeSqrtPriceX96, fullRange, priceToTick, singleSidedRange, sortTokens } from './amm/pool-math.js';

export const ARTIFACTS = Object.freeze({
	launchToken,
	liquidityLocker,
	launchRegistry,
	relayLauncher,
	uniswapV2Adapter,
	uniswapV3Adapter,
});

/** Adapters this protocol can deploy, and what each one needs to be told. */
export const ADAPTERS = Object.freeze({
	'uniswap-v2': {
		artifact: uniswapV2Adapter,
		label: 'UniswapV2Adapter',
		args: () => [AMMS['uniswap-v2'].factory, AMMS['uniswap-v2'].router, TOKENS.WETH],
	},
	'uniswap-v3': {
		artifact: uniswapV3Adapter,
		label: 'UniswapV3Adapter',
		args: () => [AMMS['uniswap-v3'].factory, AMMS['uniswap-v3'].positionManager, TOKENS.WETH],
	},
});

/** A lock that never opens. Mirrors LiquidityLocker.PERMANENT. */
export const PERMANENT = 2n ** 64n - 1n;

/**
 * Build the ordered list of transactions that stands the protocol up.
 *
 * Every address is derived from the deployer and its starting nonce, so the
 * whole graph is known before the first transaction is sent. That is what lets
 * the launcher be told about an adapter that does not exist yet, and what lets
 * a caller check the addresses they are about to create.
 *
 * @param {object} opts
 * @param {string} opts.deployer
 * @param {string} [opts.owner]         Defaults to the deployer.
 * @param {string} [opts.feeCollector]  Defaults to the owner.
 * @param {string[]} [opts.amms]        Adapter ids to deploy. Defaults to all of them.
 * @param {number|bigint} [opts.nonce]  Deployer's starting nonce. Defaults to 0.
 * @returns {{addresses: object, steps: Array<{label: string, kind: 'deploy'|'call', to?: string, data: string, value: bigint, gas: bigint}>}}
 */
export function buildDeployment({ deployer, owner = deployer, feeCollector, amms = Object.keys(ADAPTERS), nonce = 0 }) {
	for (const id of amms) if (!ADAPTERS[id]) throw new Error(`unknown adapter "${id}" (expected ${Object.keys(ADAPTERS).join(', ')})`);

	let n = BigInt(nonce);
	const next = () => getContractAddress({ from: deployer, nonce: n++ });

	const locker = next();
	const registry = next();
	const launcher = next();
	const adapters = {};
	for (const id of amms) adapters[id] = next();

	const steps = [
		deployStep('LiquidityLocker', liquidityLocker, []),
		deployStep('LaunchRegistry', launchRegistry, [owner]),
		deployStep('RelayLauncher', relayLauncher, [owner, feeCollector || owner, locker, registry]),
		...amms.map((id) => deployStep(ADAPTERS[id].label, ADAPTERS[id].artifact, ADAPTERS[id].args())),
		callStep('registry.setAuthorised(launcher)', registry, launchRegistry.abi, 'setAuthorised', [launcher, true]),
		...amms.map((id) => callStep(`launcher.setAdapter(${id})`, launcher, relayLauncher.abi, 'setAdapter', [adapters[id], true])),
	];

	return { addresses: { locker, registry, launcher, adapters }, steps };
}

function deployStep(label, artifact, args) {
	return {
		label: `deploy ${label}`,
		kind: 'deploy',
		data: args.length ? encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }) : artifact.bytecode,
		value: 0n,
		// Creation-code storage alone costs 200 gas a byte, and the largest of
		// these is twelve kilobytes. An estimate that is too tight fails in a
		// way that looks like success for every step after it.
		gas: 8_000_000n,
	};
}

function callStep(label, to, abi, functionName, args, value = 0n) {
	return { label, kind: 'call', to, data: encodeFunctionData({ abi, functionName, args }), value, gas: 500_000n };
}

/**
 * The address a launch will deploy its token to.
 *
 * Recomputed here rather than read back from a simulation, so that a
 * disagreement with `RelayLauncher.predictToken` is a test failure rather than
 * a surprise for whoever trusted the number.
 *
 * @param {object} opts
 * @param {string} opts.launcher
 * @param {string} opts.creator
 * @param {string} opts.salt
 * @param {{name: string, symbol: string, decimals: number, supply: bigint, metadataURI: string}} opts.token
 */
export function predictLaunchToken({ launcher, creator, salt, token }) {
	const initCode = `${launchToken.bytecode}${encodeAbiParameters(
		[{ type: 'string' }, { type: 'string' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'string' }, { type: 'address' }],
		[token.name, token.symbol, token.decimals, token.supply, token.metadataURI, launcher],
	).slice(2)}`;
	return getContractAddress({
		bytecode: initCode,
		from: launcher,
		opcode: 'CREATE2',
		salt: keccak256(encodePacked(['address', 'bytes32'], [creator, salt])),
	});
}

/**
 * Run a sequence of transactions on top of the current block and report what
 * each one did, without sending any of them.
 *
 * Robinhood Chain serves `eth_simulateV1`, so the protocol can be exercised
 * against the Uniswap deployment it will really run on rather than against a
 * mock of it. The deployer is funded by a state override that exists for the
 * duration of the call and nowhere else.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {string} opts.from
 * @param {Array<{label: string, kind: string, to?: string, data: string, value: bigint, gas: bigint}>} opts.steps
 * @param {bigint} [opts.balance]
 * @param {Record<string, object>} [opts.stateOverrides]
 * @returns {Promise<{ok: boolean, gasUsed: number, results: Array<object>}>}
 */
export async function simulateSteps({ client, from, steps, balance = 10_000n * 10n ** 18n, stateOverrides = {}, retries = 6 }) {
	const [block] = await withRetry(retries, () => client.request({
		method: 'eth_simulateV1',
		params: [
			{
				blockStateCalls: [{
					stateOverrides: { [from]: { balance: `0x${balance.toString(16)}` }, ...stateOverrides },
					calls: steps.map((step) => ({
						// A step may name its own sender, which is how a test
						// checks that somebody who is not the owner is refused
						// by the very contracts the owner just deployed.
						from: step.from || from,
						...(step.to ? { to: step.to } : {}),
						data: step.data,
						value: `0x${(step.value ?? 0n).toString(16)}`,
						gas: `0x${(step.gas ?? 8_000_000n).toString(16)}`,
					})),
				}],
				validation: false,
				traceTransfers: false,
			},
			'latest',
		],
	}));

	const results = steps.map((step, i) => {
		const call = block.calls[i];
		// A create that succeeds without returning code deployed nothing, and
		// every call after it would then pass for the wrong reason: a call to an
		// address with no code succeeds trivially.
		const deployedNothing = step.kind === 'deploy' && (!call.returnData || call.returnData === '0x');
		return {
			label: step.label,
			ok: call.status === '0x1' && !deployedNothing,
			gasUsed: parseInt(call.gasUsed, 16),
			codeSize: step.kind === 'deploy' && call.returnData ? (call.returnData.length - 2) / 2 : null,
			returnData: call.returnData,
			logs: call.logs || [],
			error: deployedNothing ? 'deployed no code' : call.error?.message || null,
			revertData: call.error?.data || null,
		};
	});

	return { ok: results.every((r) => r.ok), gasUsed: parseInt(block.gasUsed, 16), results };
}

/**
 * Retry a simulation through the public endpoint's rate limiter.
 *
 * A simulation is a read: retrying one cannot double-spend anything, and the
 * public RPC sits behind a challenge page that answers a burst of them with
 * HTML rather than JSON. Failing the run on that would report a contract bug
 * that does not exist, so it backs off and tries again.
 */
async function withRetry(attempts, fn) {
	let last;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			last = err;
			const message = String(err?.details || err?.shortMessage || err?.message || '');
			const throttled = /HTTP request failed|Just a moment|rate limit|429|too many/i.test(message);
			if (!throttled) throw err;
			await new Promise((resolve) => setTimeout(resolve, 2_000 * (i + 1)));
		}
	}
	throw last;
}

/**
 * Turn a human description of a launch into the exact struct `RelayLauncher`
 * takes, plus the address the token will land at.
 *
 * The starting price is computed here rather than inside the adapter on
 * purpose. A pool's initial price is the most consequential number in a
 * launch: get it wrong and the first arbitrageur takes the difference, and it
 * can only be set once. Computing it where a human can be shown it, and
 * passing it in, is the only version of that where somebody has looked.
 *
 * @param {object} opts
 * @param {string} opts.launcher
 * @param {string} opts.creator
 * @param {string} opts.adapter
 * @param {'uniswap-v2'|'uniswap-v3'} opts.amm
 * @param {{name: string, symbol: string, metadataURI?: string, decimals?: number, supply?: bigint}} opts.token
 * @param {string} opts.salt
 * @param {object} [opts.pool]
 * @param {'full-range'|'single-sided'} [opts.pool.type]
 * @param {number} [opts.pool.fee]           V3 only, hundredths of a bip.
 * @param {string} [opts.pool.quote]         Quote token, or the zero address for native ETH.
 * @param {bigint} [opts.pool.quoteAmount]
 * @param {number} [opts.pool.startFdv]      Opening valuation of the whole supply, in whole quote units.
 * @param {number} [opts.pool.rangeMultiple] How far above the start a one-sided range reaches.
 * @param {number} [opts.pool.supplyToPoolPct]
 * @param {bigint|number} [opts.unlockAt]    Defaults to permanent.
 * @param {string} [opts.feeRecipient]       Defaults to the creator.
 */
export function buildLaunch({ launcher, creator, adapter, amm, token, salt, pool = {}, unlockAt = PERMANENT, feeRecipient }) {
	const decimals = token.decimals ?? 18;
	const supply = token.supply ?? 1_000_000_000n * 10n ** BigInt(decimals);
	const metadataURI = token.metadataURI ?? '';
	const supplyToPoolPct = pool.supplyToPoolPct ?? 100;
	if (!(supplyToPoolPct > 0 && supplyToPoolPct <= 100)) throw new Error('supplyToPoolPct must be between 0 and 100');
	const supplyToPool = (supply * BigInt(Math.round(supplyToPoolPct * 100))) / 10_000n;

	const tokenAddress = predictLaunchToken({
		launcher, creator, salt,
		token: { name: token.name, symbol: token.symbol, decimals, supply, metadataURI },
	});

	const quote = pool.quote ?? (amm === 'uniswap-v2' ? ZERO_ADDRESS : TOKENS.WETH);
	const quoteAmount = pool.quoteAmount ?? 0n;
	const shape = amm === 'uniswap-v2'
		? buildV2Shape({ quoteAmount })
		: buildV3Shape({ tokenAddress, quote, quoteAmount, supplyToPool, decimals, pool });

	return {
		tokenAddress,
		describe: shape.describe,
		params: {
			name: token.name,
			symbol: token.symbol,
			metadataURI,
			decimals,
			supply,
			salt,
			adapter,
			adapterConfig: shape.config,
			supplyToPool,
			quote,
			quoteAmount,
			unlockAt: BigInt(unlockAt),
			feeRecipient: feeRecipient || creator,
		},
		/** What must be sent with the call: the native side of the pool, plus the protocol fee. */
		nativeValue: quote === ZERO_ADDRESS ? quoteAmount : 0n,
	};
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function buildV2Shape({ quoteAmount }) {
	if (quoteAmount <= 0n) throw new Error('a constant-product pool needs a quote deposit; set pool.quoteAmount');
	return { config: '0x', describe: 'constant product, both sides funded' };
}

function buildV3Shape({ tokenAddress, quote, quoteAmount, supplyToPool, decimals, pool }) {
	const type = pool.type ?? 'single-sided';
	const fee = pool.fee ?? 10_000;
	const spacing = AMMS['uniswap-v3'].feeTiers[fee];
	if (!spacing) throw new Error(`fee tier ${fee} is not enabled on this chain`);

	const quoteDecimals = quote.toLowerCase() === TOKENS.USDG.toLowerCase() ? 6 : 18;
	const wholeSupply = Number(supplyToPool) / 10 ** decimals;
	const pricePerToken = pool.startPrice !== undefined
		? Number(pool.startPrice)
		: pool.startFdv !== undefined
			? Number(pool.startFdv) / wholeSupply
			: quoteAmount > 0n
				? Number(quoteAmount) / 10 ** quoteDecimals / wholeSupply
				: undefined;
	if (pricePerToken === undefined) {
		throw new Error('a one-sided launch has no deposit to imply a price from; set pool.startFdv or pool.startPrice');
	}

	const oneToken = 10n ** BigInt(decimals);
	const quotePerToken = BigInt(Math.round(pricePerToken * 10 ** quoteDecimals));
	if (quotePerToken <= 0n) throw new Error('the starting price rounds to zero in the quote asset; raise it');

	const { flipped } = sortTokens(tokenAddress, quote);
	const sqrtPriceX96 = flipped
		? encodeSqrtPriceX96(oneToken, quotePerToken)
		: encodeSqrtPriceX96(quotePerToken, oneToken);

	let range;
	if (type === 'full-range') {
		range = fullRange(spacing);
	} else {
		const currentTick = priceToTick(Number(sqrtPriceX96) ** 2 / 2 ** 192);
		const multiple = pool.rangeMultiple ?? 1000;
		if (flipped) {
			// The launch token sorted above the quote, so its sell side is below
			// the current price rather than above it.
			const span = Math.log(multiple) / Math.log(1.0001);
			const tickUpper = alignTick(currentTick, spacing, 'down');
			range = { tickLower: alignTick(tickUpper - span, spacing, 'down'), tickUpper };
		} else {
			range = singleSidedRange({ currentTick, spacing, multiple });
		}
	}
	if (range.tickLower >= range.tickUpper) throw new Error('the range collapsed to nothing; widen rangeMultiple or use a finer fee tier');

	return {
		config: encodeAbiParameters(
			[{ type: 'tuple', components: [{ type: 'uint24' }, { type: 'uint160' }, { type: 'int24' }, { type: 'int24' }] }],
			[[fee, sqrtPriceX96, range.tickLower, range.tickUpper]],
		),
		describe: `${type}, ${fee / 10_000}% fee, ticks ${range.tickLower}..${range.tickUpper}`,
	};
}
