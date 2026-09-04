// Launch by opening your own pool.
//
// Every launchpad in the catalog is, underneath, a contract that deploys a
// token and puts it in an AMM pool on terms its operator chose. This target
// does the same thing with the terms as arguments: which AMM, which quote
// asset, what fee, how wide a range, how much of the supply, at what starting
// price. No launch fee to anyone, no metadata service to depend on, and no
// contract in the middle that can change what it does next week.
//
// The three families cover the pool shapes available on this chain:
//
//   uniswap-v2   constant product. One price curve from zero to infinity, both
//                sides funded. The simplest thing that can be called a market.
//   uniswap-v3   concentrated. Full range behaves like V2 with better fee
//                capture; a range above spot is a launch with no quote capital
//                at all, where every token is offered for sale upward and the
//                pool fills with quote as people buy.
//   uniswap-v4   the same positions inside a singleton, with a hook address in
//                the pool key. A pool created here can carry any hook already
//                deployed on the chain.
//
// V2 and V3 forks on Robinhood Chain implement these interfaces unchanged, so
// pointing `factory` at a fork launches on the fork.
//
// One caveat is structural and worth stating plainly: a pool launch is several
// transactions, and only the first can be simulated before it exists. The
// token is deployed, then approved, then paired. `plan` prices the deployment
// exactly and prices the rest against a stated gas allowance, because
// estimating a call to a contract that does not exist yet is not possible.
// `execute` estimates every step for real immediately before sending it, and
// unused gas is refunded by the EVM, so the allowance is a ceiling rather than
// a cost.

import {
	createPublicClient, encodeAbiParameters, encodeFunctionData, encodePacked, formatEther,
	formatUnits, getAddress, getContractAddress, http, parseUnits,
} from 'viem';
import artifact from '../artifacts/launch-token.json' with { type: 'json' };
import { AMMS, NATIVE_ADDRESS, TOKENS } from '../contracts.js';
import { addressUrl, robinhoodChain, tokenUrl, txUrl } from '../chain.js';
import {
	V4_ACTIONS, erc20Abi, permit2Abi, v2RouterAbi, v3FactoryAbi, v3PositionManagerAbi, v4PositionManagerAbi,
} from './abis.js';
import {
	alignTick, encodeSqrtPriceX96, fullRange, liquidityForAmounts, priceToTick, singleSidedRange,
	sortTokens, sqrtPriceX96AtTick,
} from './pool-math.js';

const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT160 = 2n ** 160n - 1n;
const DEFAULT_SUPPLY = 1_000_000_000n;
const DEFAULT_DECIMALS = 18;
const DEFAULT_DEADLINE_SECONDS = 600;
/** Ceiling for a step that cannot be estimated before the token exists. */
const DEFAULT_STEP_GAS = 1_500_000n;

/**
 * @param {object} opts
 * @param {'uniswap-v2'|'uniswap-v3'|'uniswap-v4'} [opts.amm]
 * @param {string} [opts.quote]            Quote token address, a key of TOKENS, or 'ETH' for native.
 * @param {'full-range'|'single-sided'} [opts.poolType]
 * @param {number} [opts.fee]              Fee in hundredths of a bip (3000 = 0.30%). V3 and V4 only.
 * @param {number} [opts.tickSpacing]      V4 only; V3 reads it from the factory.
 * @param {string} [opts.hooks]            V4 hook address. Defaults to none.
 * @param {bigint|number|string} [opts.supply]  Whole tokens. Default 1,000,000,000.
 * @param {number} [opts.decimals]         Default 18.
 * @param {string|number} [opts.startPrice] Quote per token, in human units.
 * @param {string|number} [opts.startFdv]   Alternative to startPrice: value of the whole supply, in quote units.
 * @param {string|number} [opts.quoteAmount] Quote to deposit. Required for a two-sided pool.
 * @param {number} [opts.supplyInPoolPct]  Share of supply that goes into the pool. Default 100.
 * @param {number} [opts.rangeMultiple]    Top of a single-sided range, as a multiple of the start price. Default 1000.
 * @param {string} [opts.factory]          Override the AMM's factory, to launch on a fork.
 * @param {string} [opts.rpcUrl]
 * @param {bigint} [opts.stepGas]
 * @returns {import('../../../types.js').Target}
 */
export function createPoolLaunchTarget(opts = {}) {
	const ammId = opts.amm || 'uniswap-v3';
	const amm = AMMS[ammId];
	if (!amm) throw new Error(`unknown AMM "${ammId}" (expected ${Object.keys(AMMS).join(', ')})`);
	const chain = robinhoodChain({ rpcUrl: opts.rpcUrl });
	const poolType = opts.poolType || 'single-sided';
	if (!['full-range', 'single-sided'].includes(poolType)) throw new Error(`unknown poolType "${poolType}"`);
	if (ammId === 'uniswap-v2' && poolType === 'single-sided') {
		throw new Error('a constant-product pool cannot be one-sided; use full-range on uniswap-v2, or single-sided on uniswap-v3 or uniswap-v4');
	}

	const decimals = opts.decimals ?? DEFAULT_DECIMALS;
	const supply = BigInt(opts.supply ?? DEFAULT_SUPPLY) * 10n ** BigInt(decimals);
	const supplyInPoolPct = opts.supplyInPoolPct ?? 100;
	if (!(supplyInPoolPct > 0 && supplyInPoolPct <= 100)) throw new Error('supplyInPoolPct must be between 0 and 100');
	const poolTokens = (supply * BigInt(Math.round(supplyInPoolPct * 100))) / 10_000n;

	const quote = resolveQuote(opts.quote ?? (ammId === 'uniswap-v2' ? 'ETH' : 'WETH'), ammId);
	const fee = opts.fee ?? 10_000;
	const factory = opts.factory || amm.factory || amm.poolManager;
	const stepGas = opts.stepGas ?? DEFAULT_STEP_GAS;
	const deadlineSeconds = opts.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;

	const readClient = () =>
		opts.publicClient || createPublicClient({ chain, transport: http(opts.rpcUrl || chain.rpcUrls.default.http[0]) });

	return {
		id: `pool:${ammId}`,
		chain: chain.name,
		chainId: chain.id,
		nativeSymbol: 'ETH',
		nativeDecimals: 18,
		viemChain: chain,
		amm: { id: ammId, ...amm, factory },
		quote,
		poolType,

		async health() {
			const client = readClient();
			const code = await client.getCode({ address: getAddress(factory) });
			if (!code || code.length <= 2) return { ok: false, detail: `${amm.label} factory ${factory} has no code` };
			if (ammId === 'uniswap-v3') {
				const spacing = await client.readContract({ address: getAddress(factory), abi: v3FactoryAbi, functionName: 'feeAmountTickSpacing', args: [fee] });
				if (Number(spacing) === 0) return { ok: false, detail: `${amm.label} does not enable the ${fee / 10_000}% fee tier` };
			}
			return { ok: true, detail: `${amm.label} ${poolType} pool quoted in ${quote.symbol}, ${factory}` };
		},

		/**
		 * @param {import('../../../types.js').LaunchSpec} spec
		 * @param {{wallet: import('../../../types.js').WalletHandle, log: import('../../../types.js').Logger, dryRun?: boolean}} ctx
		 */
		async plan(spec, { wallet, log, dryRun = false }) {
			const publicClient = wallet.publicClient || readClient();
			const warnings = [];

			// The token is deployed with CREATE, so its address is a function of
			// this wallet and this nonce. Knowing it in advance is what lets the
			// whole flow (token ordering, price, pool key) be decided and shown
			// before anything is signed.
			const nonce = await publicClient.getTransactionCount({ address: wallet.address, blockTag: 'pending' });
			const token = getContractAddress({ from: wallet.address, nonce: BigInt(nonce) });

			const metadataURI = spec.targetHints?.metadataUri || spec.imageUrl || '';
			const deployData = encodeDeploy({ spec, decimals, supply, metadataURI, mintTo: wallet.address });

			const quoteAmount = opts.quoteAmount === undefined ? 0n : parseUnits(String(opts.quoteAmount), quote.decimals);
			if (poolType === 'full-range' && quoteAmount <= 0n) {
				throw new Error(`a full-range pool needs quote liquidity; pass quoteAmount (in ${quote.symbol})`);
			}
			const startPrice = resolveStartPrice({ opts, poolTokens, quoteAmount, decimals, quote });

			const { token0, token1, flipped } = sortTokens(token, quote.address);
			// The pool stores price as token1 per token0 in base units, so the
			// ratio has to be built from base units too, not from human ones.
			const oneToken = 10n ** BigInt(decimals);
			const quotePerToken = parseUnits(startPrice.toFixed(quote.decimals), quote.decimals);
			if (quotePerToken <= 0n) throw new Error('start price rounds to zero in the quote asset; raise it or use a quote with more decimals');
			const sqrtPriceX96 = flipped
				? encodeSqrtPriceX96(oneToken, quotePerToken)
				: encodeSqrtPriceX96(quotePerToken, oneToken);

			const shared = { token, token0, token1, flipped, sqrtPriceX96, poolTokens, quoteAmount, quote, fee, decimals, deadlineSeconds, wallet, poolType, rangeMultiple: opts.rangeMultiple ?? 1000, hooks: opts.hooks || NATIVE_ADDRESS };
			const steps = ammId === 'uniswap-v2'
				? v2Steps({ ...shared, amm })
				: ammId === 'uniswap-v3'
					? await v3Steps({ ...shared, amm, factory, publicClient })
					: v4Steps({ ...shared, amm, tickSpacing: opts.tickSpacing ?? amm.feeTiers[fee] ?? 60 });

			// Only the deployment can be estimated: everything after it calls a
			// contract that does not exist yet.
			let deployGas;
			try {
				deployGas = await publicClient.estimateGas({ account: wallet.signer, data: deployData, to: null });
			} catch (err) {
				if (!dryRun) throw new Error(`token deployment simulation failed: ${short(err)}`);
				warnings.push(`deployment estimate failed: ${short(err)}`);
				deployGas = 900_000n;
			}
			const gasPrice = await publicClient.getGasPrice();
			const gasCeiling = deployGas + stepGas * BigInt(steps.length);
			const gasCost = gasCeiling * gasPrice;
			const nativeSpend = steps.reduce((sum, step) => sum + (step.value || 0n), 0n);
			const total = gasCost + nativeSpend;

			warnings.push(`${steps.length} follow-up transaction(s) are priced at a ${stepGas} gas ceiling each because they call a contract that does not exist yet; each is estimated for real before it is sent, and the EVM refunds the difference`);
			if (quote.native === false && quoteAmount > 0n) {
				const [balance, allowance] = await Promise.all([
					publicClient.readContract({ address: quote.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] }),
					Promise.resolve(0n),
				]);
				if (balance < quoteAmount) {
					throw new Error(`wallet holds ${formatUnits(balance, quote.decimals)} ${quote.symbol} but the pool needs ${formatUnits(quoteAmount, quote.decimals)}`);
				}
			}
			if (poolType === 'single-sided') {
				warnings.push('single-sided: the pool opens with no quote liquidity, so the first buy sets the first real price');
			}
			if (supplyInPoolPct < 100) {
				warnings.push(`${(100 - supplyInPoolPct).toFixed(2)}% of supply stays in the launching wallet and is not in the pool`);
			}

			return {
				target: `pool:${ammId}`,
				chain: chain.name,
				chainId: chain.id,
				spec,
				wallet: wallet.address,
				contract: factory,
				cost: {
					nativeSymbol: 'ETH',
					feeNative: formatEther(nativeSpend),
					gasNative: formatEther(gasCost),
					totalNative: formatEther(total),
					totalBase: total,
				},
				warnings,
				dryRun,
				plannedAt: Date.now(),
				call: { token, nonce, deployData, deployGas, steps, stepGas, sqrtPriceX96 },
				pool: { amm: ammId, factory, fee, quote: quote.symbol, quoteAddress: quote.address, poolType, token0, token1, startPrice, poolTokens: poolTokens.toString() },
				summary: summarize({ ammId, amm, spec, wallet, token, quote, fee, poolType, startPrice, poolTokens, quoteAmount, decimals, steps, gasCost, nativeSpend, total }),
			};
		},

		/**
		 * @param {object} plan
		 * @param {{wallet: import('../../../types.js').WalletHandle, log: import('../../../types.js').Logger}} ctx
		 */
		async execute(plan, { wallet, log }) {
			if (plan.dryRun) throw new Error('cannot execute a dry-run plan; build a live plan first');
			if (wallet.address.toLowerCase() !== String(plan.wallet).toLowerCase()) {
				throw new Error(`plan was priced for ${plan.wallet}, not ${wallet.address}`);
			}
			const publicClient = wallet.publicClient || readClient();

			// The token address was predicted from a nonce. If anything else
			// used this wallet in between, the prediction is wrong and every
			// following step would reference a contract that is not ours.
			const nonce = await publicClient.getTransactionCount({ address: wallet.address, blockTag: 'pending' });
			if (nonce !== plan.call.nonce) {
				throw new Error(`wallet nonce moved from ${plan.call.nonce} to ${nonce} since planning; re-plan so the token address is predicted correctly`);
			}

			const deployHash = await wallet.client.sendTransaction({ account: wallet.signer, chain, data: plan.call.deployData, gas: (plan.call.deployGas * 125n) / 100n });
			log.info(`token deployment sent ${deployHash}`);
			const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
			if (deployReceipt.status !== 'success') {
				return { ok: false, txHash: deployHash, url: txUrl(deployHash), error: 'token deployment reverted' };
			}
			const token = getAddress(deployReceipt.contractAddress);
			if (token.toLowerCase() !== String(plan.call.token).toLowerCase()) {
				return { ok: false, txHash: deployHash, url: txUrl(deployHash), error: `token deployed to ${token}, not the planned ${plan.call.token}` };
			}

			const txHashes = [deployHash];
			for (const step of plan.call.steps) {
				let gas;
				try {
					gas = await publicClient.estimateGas({ account: wallet.signer, to: step.to, data: step.data, value: step.value || 0n });
				} catch (err) {
					return { ok: false, txHash: txHashes.at(-1), tokenAddress: token, url: tokenUrl(token), error: `step "${step.label}" would revert: ${short(err)}`, txHashes };
				}
				const hash = await wallet.client.sendTransaction({ account: wallet.signer, chain, to: step.to, data: step.data, value: step.value || 0n, gas: (gas * 125n) / 100n });
				log.info(`${step.label} sent ${hash}`);
				txHashes.push(hash);
				const receipt = await publicClient.waitForTransactionReceipt({ hash });
				if (receipt.status !== 'success') {
					return { ok: false, txHash: hash, tokenAddress: token, url: txUrl(hash), error: `step "${step.label}" reverted on chain`, txHashes };
				}
			}

			return {
				ok: true,
				txHash: deployHash,
				txHashes,
				tokenAddress: token,
				url: tokenUrl(token),
				explorerUrl: txUrl(deployHash),
				tokenExplorerUrl: addressUrl(token),
			};
		},
	};
}

/** Constructor-encoded creation code for the fixed-supply launch token. */
export function encodeDeploy({ spec, decimals, supply, metadataURI, mintTo }) {
	const constructorInputs = artifact.abi.find((entry) => entry.type === 'constructor').inputs;
	const encoded = encodeAbiParameters(constructorInputs, [spec.name, spec.symbol, decimals, supply, metadataURI || '', getAddress(mintTo)]);
	return `${artifact.bytecode}${encoded.slice(2)}`;
}

function v2Steps({ token, quote, poolTokens, quoteAmount, deadlineSeconds, wallet, amm }) {
	const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
	const steps = [approveStep(token, amm.router, poolTokens, 'approve the router for the launch token')];
	if (quote.native) {
		steps.push({
			label: 'create the pair and add liquidity',
			to: getAddress(amm.router),
			value: quoteAmount,
			data: encodeFunctionData({
				abi: v2RouterAbi,
				functionName: 'addLiquidityETH',
				args: [token, poolTokens, poolTokens, quoteAmount, wallet.address, deadline],
			}),
		});
		return steps;
	}
	steps.push(approveStep(quote.address, amm.router, quoteAmount, `approve the router for ${quote.symbol}`));
	steps.push({
		label: 'create the pair and add liquidity',
		to: getAddress(amm.router),
		value: 0n,
		data: encodeFunctionData({
			abi: v2RouterAbi,
			functionName: 'addLiquidity',
			args: [token, quote.address, poolTokens, quoteAmount, poolTokens, quoteAmount, wallet.address, deadline],
		}),
	});
	return steps;
}

async function v3Steps({ token, token0, token1, flipped, sqrtPriceX96, poolTokens, quoteAmount, quote, fee, poolType, rangeMultiple, deadlineSeconds, wallet, amm, factory, publicClient }) {
	const spacing = Number(await publicClient.readContract({ address: getAddress(factory), abi: v3FactoryAbi, functionName: 'feeAmountTickSpacing', args: [fee] }));
	if (!spacing) throw new Error(`fee tier ${fee} is not enabled on ${factory}`);
	const range = rangeFor({ poolType, sqrtPriceX96, spacing, flipped, rangeMultiple });
	const { amount0, amount1 } = amountsFor({ flipped, poolTokens, quoteAmount, poolType });
	const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
	const posm = getAddress(amm.positionManager);

	const steps = [approveStep(token, posm, poolTokens, 'approve the position manager for the launch token')];
	if (!quote.native && quoteAmount > 0n) steps.push(approveStep(quote.address, posm, quoteAmount, `approve the position manager for ${quote.symbol}`));
	steps.push({
		label: 'create and initialise the pool',
		to: posm,
		value: 0n,
		data: encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'createAndInitializePoolIfNecessary', args: [token0, token1, fee, sqrtPriceX96] }),
	});
	steps.push({
		label: 'mint the position',
		to: posm,
		value: 0n,
		data: encodeFunctionData({
			abi: v3PositionManagerAbi,
			functionName: 'mint',
			args: [{
				token0, token1, fee,
				tickLower: range.tickLower, tickUpper: range.tickUpper,
				amount0Desired: amount0, amount1Desired: amount1,
				// The pool was just initialised by this same flow, so there is
				// no other liquidity to slip against. Zero minimums here would
				// be reckless on an existing pool and are correct on a new one.
				amount0Min: 0n, amount1Min: 0n,
				recipient: wallet.address, deadline,
			}],
		}),
	});
	return steps;
}

function v4Steps({ token, token0, token1, flipped, sqrtPriceX96, poolTokens, quoteAmount, quote, fee, tickSpacing, hooks, poolType, rangeMultiple, deadlineSeconds, wallet, amm }) {
	const range = rangeFor({ poolType, sqrtPriceX96, spacing: tickSpacing, flipped, rangeMultiple });
	const { amount0, amount1 } = amountsFor({ flipped, poolTokens, quoteAmount, poolType });
	const posm = getAddress(amm.positionManager);
	const permit2 = getAddress(amm.permit2);
	// V4 addresses native ETH as the zero address rather than wrapping it.
	const currency0 = quote.native && !flipped ? NATIVE_ADDRESS : token0;
	const currency1 = quote.native && flipped ? NATIVE_ADDRESS : token1;
	const key = { currency0: getAddress(currency0), currency1: getAddress(currency1), fee, tickSpacing, hooks: getAddress(hooks) };

	const liquidity = liquidityForAmounts({
		sqrtPriceX96,
		sqrtPriceLowerX96: sqrtPriceX96AtTick(range.tickLower),
		sqrtPriceUpperX96: sqrtPriceX96AtTick(range.tickUpper),
		amount0, amount1,
	});
	if (liquidity <= 0n) throw new Error('the requested deposit supports no liquidity in this range');

	const actions = encodePacked(['uint8', 'uint8'], [V4_ACTIONS.MINT_POSITION, V4_ACTIONS.SETTLE_PAIR]);
	const mintParams = encodeAbiParameters(
		[
			{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
			{ type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' },
		],
		[key, range.tickLower, range.tickUpper, liquidity, amount0 || 1n, amount1 || 1n, wallet.address, '0x'],
	);
	const settleParams = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [key.currency0, key.currency1]);
	const unlockData = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [mintParams, settleParams]]);
	const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

	// Permit2 sits between the wallet and the position manager: the token is
	// approved to Permit2, and Permit2 is told to let the position manager
	// pull it. Two approvals, not one, and both are on-chain calls.
	const steps = [
		approveStep(token, permit2, MAX_UINT256, 'approve Permit2 for the launch token'),
		{
			label: 'let the position manager pull the launch token',
			to: permit2,
			value: 0n,
			data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, posm, MAX_UINT160, permit2Expiration()] }),
		},
	];
	if (!quote.native && quoteAmount > 0n) {
		steps.push(approveStep(quote.address, permit2, MAX_UINT256, `approve Permit2 for ${quote.symbol}`));
		steps.push({
			label: `let the position manager pull ${quote.symbol}`,
			to: permit2,
			value: 0n,
			data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [quote.address, posm, MAX_UINT160, permit2Expiration()] }),
		});
	}
	steps.push({
		label: 'initialise the pool and mint the position',
		to: posm,
		value: quote.native ? quoteAmount : 0n,
		data: encodeFunctionData({
			abi: v4PositionManagerAbi,
			functionName: 'multicall',
			args: [[
				encodeFunctionData({ abi: v4PositionManagerAbi, functionName: 'initializePool', args: [key, sqrtPriceX96] }),
				encodeFunctionData({ abi: v4PositionManagerAbi, functionName: 'modifyLiquidities', args: [unlockData, deadline] }),
			]],
		}),
	});
	return steps;
}

/** Permit2 expirations are uint48 seconds. A day is plenty for a launch. */
const permit2Expiration = () => BigInt(Math.floor(Date.now() / 1000) + 86_400);

function approveStep(token, spender, amount, label) {
	return {
		label,
		to: getAddress(token),
		value: 0n,
		data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [getAddress(spender), amount] }),
	};
}

/**
 * Which side of the pool holds what. A single-sided launch deposits only the
 * launch token, whichever index it sorted into.
 */
function amountsFor({ flipped, poolTokens, quoteAmount, poolType }) {
	const quoteSide = poolType === 'single-sided' ? 0n : quoteAmount;
	return flipped ? { amount0: quoteSide, amount1: poolTokens } : { amount0: poolTokens, amount1: quoteSide };
}

/**
 * The tick range the position occupies.
 *
 * For a single-sided launch the range must sit strictly on the launch token's
 * side of the current price, and which side that is depends on whether the
 * token sorted below or above the quote.
 */
function rangeFor({ poolType, sqrtPriceX96, spacing, flipped, rangeMultiple }) {
	if (poolType === 'full-range') return fullRange(spacing);
	const currentTick = priceToTick(Number(sqrtPriceX96) ** 2 / 2 ** 192);
	if (!flipped) return singleSidedRange({ currentTick, spacing, multiple: rangeMultiple });
	// The launch token is token1, so its sell side is below the current price.
	const tickUpper = alignTick(currentTick, spacing, 'down');
	const span = Math.log(rangeMultiple) / Math.log(1.0001);
	const tickLower = alignTick(tickUpper - span, spacing, 'down');
	if (tickLower >= tickUpper) throw new Error('range collapsed to nothing; widen rangeMultiple or use a finer tick spacing');
	return { tickLower, tickUpper };
}

function resolveQuote(quote, ammId) {
	const key = String(quote).toUpperCase();
	if (key === 'ETH') {
		if (ammId === 'uniswap-v3') throw new Error('uniswap-v3 pools quote in WETH, not native ETH; pass quote: "WETH"');
		return { symbol: 'ETH', address: ammId === 'uniswap-v4' ? NATIVE_ADDRESS : TOKENS.WETH, decimals: 18, native: true };
	}
	if (TOKENS[key]) return { symbol: key, address: TOKENS[key], decimals: key === 'USDG' ? 6 : 18, native: false };
	if (/^0x[0-9a-fA-F]{40}$/.test(quote)) return { symbol: quote.slice(0, 8), address: getAddress(quote), decimals: 18, native: false };
	throw new Error(`unknown quote "${quote}" (use ETH, ${Object.keys(TOKENS).join(', ')}, or a token address)`);
}

function resolveStartPrice({ opts, poolTokens, quoteAmount, decimals, quote }) {
	if (opts.startPrice !== undefined) return Number(opts.startPrice);
	if (opts.startFdv !== undefined) {
		const wholeSupply = Number(poolTokens) / 10 ** decimals;
		return Number(opts.startFdv) / wholeSupply;
	}
	if (quoteAmount > 0n) {
		return (Number(quoteAmount) / 10 ** quote.decimals) / (Number(poolTokens) / 10 ** decimals);
	}
	throw new Error('a single-sided launch has no deposit to imply a price from; pass startPrice or startFdv');
}

function summarize({ ammId, amm, spec, wallet, token, quote, fee, poolType, startPrice, poolTokens, quoteAmount, decimals, steps, gasCost, nativeSpend, total }) {
	const whole = Number(poolTokens) / 10 ** decimals;
	return [
		`launch      your own ${amm.label} pool on Robinhood Chain (chain 4663)`,
		`token       ${spec.name} (${spec.symbol}), deploying to ${token}`,
		`pool        ${poolType}, quoted in ${quote.symbol}${ammId === 'uniswap-v2' ? '' : `, ${fee / 10_000}% fee`}`,
		`liquidity   ${whole.toLocaleString('en-US')} ${spec.symbol}${quoteAmount > 0n ? ` + ${formatUnits(quoteAmount, quote.decimals)} ${quote.symbol}` : ' and no quote deposit'}`,
		`start price ${startPrice} ${quote.symbol} per ${spec.symbol}`,
		`from wallet ${wallet.address} (${wallet.label})`,
		`transactions 1 deployment + ${steps.length} follow-up (${steps.map((s) => s.label).join('; ')})`,
		`deposit     ${formatEther(nativeSpend)} ETH`,
		`gas ceiling ${formatEther(gasCost)} ETH`,
		`total       ${formatEther(total)} ETH`,
		`origin      ${spec.origin?.source || 'manual'} ${spec.origin?.address || ''}`.trim(),
	];
}

const short = (err) => String(err?.shortMessage || err?.details || err?.message || err).split('\n')[0].slice(0, 220);
