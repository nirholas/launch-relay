// PAIR launchpad target (Robinhood Chain, EVM).
//
// One transaction deploys a fixed-supply ERC-20 into one to five permanently
// locked Uniswap V4 pools, each paired with a Robinhood Stock Token. The
// launch fee is read from the contract rather than assumed, and the developer
// buy is off by default: a relay that buys its own token needs stock-token
// balances and an ERC-20 approval in every wallet, which is a different and
// much larger commitment than paying a flat fee to deploy.
//
// The split between `plan` and `execute` is the safety boundary. `plan` does
// every read, upload, and simulation and returns a priced, human-readable
// object. `execute` signs exactly that. Nothing between them can change what
// gets sent except the deadline check, which refuses a stale plan instead of
// silently rebuilding it.

import { createPublicClient, formatEther, http, keccak256, toBytes } from 'viem';
import { createPairFundApi } from './api.js';
import { createMarketSelector } from './markets.js';
import { addressUrl, robinhoodChain, txUrl } from './chain.js';
import { BPS_TOTAL, NO_DEVELOPER_BUY, PAIR_LAUNCHPAD_V5, PAIR_TOTAL_SUPPLY, launchpadAbi } from './abi.js';

// PAIR's ETH/USD feed. launchTokenMulti reads it for the milestone target and
// reverts with StalePrice when the keeper has not written for two hours, so
// its freshness decides whether any launch on the platform can succeed.
const ETH_PRICE_FEED = '0x3258Df8c1F1C9f5BFE83e118Fa343af6217CFc69';
const STALE_PRICE_SELECTOR = '0xeb1fe96e'; // StalePrice(address,uint256)
const feedAbi = [{ inputs: [], name: 'latestRoundData', outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }], stateMutability: 'view', type: 'function' }];

/** Walk a viem error chain for a revert selector. */
function revertSelector(err) {
	for (let e = err, i = 0; e && i < 8; e = e.cause, i++) if (e.signature) return e.signature;
	return null;
}

/**
 * A stale oracle is the platform's outage, not this launch's fault. The
 * engine treats a paused target as a skip rather than a retry: retrying
 * uploads metadata three times per coin for a revert that cannot clear until
 * PAIR's keeper writes again.
 */
function oracleStale(detail) {
	const err = new Error(`PAIR oracle is stale (${detail}); launches revert with StalePrice until the price keeper resumes`);
	err.code = 'target-paused';
	return err;
}

/** The frontend's fallback when estimation is unavailable. */
const FALLBACK_GAS = 8_000_000n;
const GAS_BUFFER_NUM = 115n;
const GAS_BUFFER_DEN = 100n;
const STOCK_TOKEN_TTL_MS = 60_000;
const LAUNCH_FEE_TTL_MS = 600_000;
const DEFAULT_DEADLINE_SECONDS = 600;

/**
 * @param {object} [opts]
 * @param {string} [opts.rpcUrl]
 * @param {string} [opts.launchpad]          Launchpad proxy address. Defaults to the pinned V5 proxy.
 * @param {string} [opts.apiBase]
 * @param {object} [opts.marketSelector]     Config for createMarketSelector.
 * @param {number} [opts.deadlineSeconds]
 * @param {string} [opts.creatorFeeRecipient] Where creator fees accrue. Defaults to the launching wallet.
 * @param {object} [opts.api]                Injected API client, for tests.
 * @returns {import('../../types.js').Target}
 */
export function createPairFundTarget(opts = {}) {
	const chain = robinhoodChain({ rpcUrl: opts.rpcUrl });
	const launchpad = opts.launchpad || PAIR_LAUNCHPAD_V5;
	const api = opts.api || createPairFundApi({ baseUrl: opts.apiBase });
	const selector = opts.marketSelector?.select
		? opts.marketSelector
		: createMarketSelector(opts.marketSelector || {});
	const deadlineSeconds = opts.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
	// Default on: a blank listing is worse than one fewer listing. Set false to
	// keep the old behaviour of launching whatever the mirror managed to get.
	const requireArtwork = opts.requireArtwork !== false;

	let stockCache = { at: 0, tokens: null };
	async function stockTokens() {
		if (stockCache.tokens && Date.now() - stockCache.at < STOCK_TOKEN_TTL_MS) return stockCache.tokens;
		const tokens = await api.stockTokens();
		if (!Array.isArray(tokens) || !tokens.length) throw new Error('PAIR returned no stock tokens');
		stockCache = { at: Date.now(), tokens };
		return tokens;
	}

	// The launch fee is a governance parameter that changes at most a handful of
	// times in a contract's life, yet it was read from chain on every launch. A
	// short TTL keeps a fee change picked up within minutes while taking one RPC
	// round trip out of the hot path.
	let feeCache = { at: 0, wei: null };
	async function launchFeeWei(publicClient) {
		if (feeCache.wei !== null && Date.now() - feeCache.at < LAUNCH_FEE_TTL_MS) return feeCache.wei;
		const wei = await publicClient.readContract({
			address: launchpad, abi: launchpadAbi, functionName: 'launchFeeWei',
		});
		feeCache = { at: Date.now(), wei };
		return wei;
	}

	return {
		id: 'pairfund',
		chain: chain.name,
		chainId: chain.id,
		nativeSymbol: 'ETH',
		nativeDecimals: 18,
		viemChain: chain,
		api,

		symbolTaken: (symbol) => api.symbolTaken(symbol),

		async health() {
			const [{ status }, tokens] = await Promise.all([api.health(), stockTokens()]);
			const enabled = tokens.filter((t) => t.enabled).length;
			let oracle = 'oracle fresh';
			let oracleOk = true;
			try {
				const pc = opts.publicClient || createPublicClient({ chain, transport: http(opts.rpcUrl || chain.rpcUrls.default.http[0]) });
				await pc.readContract({ address: ETH_PRICE_FEED, abi: feedAbi, functionName: 'latestRoundData' });
			} catch (err) {
				if (revertSelector(err) === STALE_PRICE_SELECTOR) { oracle = 'oracle STALE: every launch reverts until the keeper resumes'; oracleOk = false; }
				else oracle = `oracle unreadable: ${shortError(err)}`;
			}
			return {
				ok: status === 'ok' && enabled > 0 && oracleOk,
				detail: `api ${status}, ${enabled}/${tokens.length} stock markets enabled, ${oracle}`,
			};
		},

		/**
		 * @param {import('../../types.js').LaunchSpec} spec
		 * @param {{wallet: import('../../types.js').WalletHandle, log: import('../../types.js').Logger, dryRun?: boolean}} ctx
		 * @returns {Promise<import('../../types.js').LaunchPlan>}
		 */
		async plan(spec, { wallet, log, dryRun = false }) {
			const warnings = [];
			const publicClient = wallet.publicClient;
			if (!publicClient) throw new Error('PAIR target needs a wallet handle carrying a viem public client');

			const selection = selector.select(spec, await stockTokens());
			log.debug('markets', selection.rationale);

			// One cheap read before any upload: if the ETH feed is stale the
			// launch will revert, and there is no point hosting artwork and a
			// descriptor for a transaction that cannot be sent.
			if (!dryRun) {
				try {
					await publicClient.readContract({ address: ETH_PRICE_FEED, abi: feedAbi, functionName: 'latestRoundData' });
				} catch (err) {
					if (revertSelector(err) === STALE_PRICE_SELECTOR) throw oracleStale('ETH/USD feed');
					throw err;
				}
			}

			// Artwork and descriptor. A dry run stays read-only: it neither
			// uploads an image nor stores a descriptor, so a tuning session does
			// not leave orphaned metadata on PAIR's host.
			let imageUrl = null;
			let metadataURI;
			let metadataHash;
			if (dryRun) {
				({ metadataURI, metadataHash } = previewMetadata(api.baseUrl, spec));
				warnings.push('dry run: metadata was hashed locally and not uploaded');
			} else {
				if (spec.imageUrl) {
					imageUrl = await api.mirrorImage(spec.imageUrl);
					if (!imageUrl) {
						// A token launched with no logo looks abandoned on the
						// listing forever, and the artwork cannot be added after
						// the fact. When the operator asks for artwork, a source
						// image that no gateway will serve is a reason to skip the
						// coin, not to mint a blank one.
						if (requireArtwork) {
							throw new Error(`artwork unavailable at ${spec.imageUrl}; every gateway refused it`);
						}
						warnings.push(`source image could not be mirrored: ${spec.imageUrl}`);
					}
				}
				({ metadataURI, metadataHash } = await api.uploadMetadata({
					name: spec.name,
					symbol: spec.symbol,
					description: spec.description,
					image: imageUrl || undefined,
					twitter: spec.links?.twitter || undefined,
					telegram: spec.links?.telegram || undefined,
					website: spec.links?.website || undefined,
				}));
			}

			const launchFee = await launchFeeWei(publicClient);

			const devBuy = normalizeDevBuy(spec.targetHints?.devBuy, selection.markets, warnings);
			const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
			const params = {
				name: spec.name,
				symbol: spec.symbol,
				metadataURI,
				metadataHash,
				allocations: selection.markets.map((m) => ({ quoteToken: m.address, weightBps: m.weightBps })),
				creatorFeeRecipient: opts.creatorFeeRecipient || wallet.address,
				// Even a disabled buy names a real recipient: on-chain launches all
				// carry the creator's address here, and a zero address is refused.
				developerBuyRecipient: devBuy.recipient || wallet.address,
				developerBuyPairIndex: devBuy.pairIndex,
				developerTokenAmountOut: devBuy.tokenAmountOut,
				maxQuoteAmountIn: devBuy.maxQuoteIn,
				deadline,
			};

			const call = {
				address: launchpad,
				abi: launchpadAbi,
				functionName: 'launchTokenMulti',
				args: [params],
				value: launchFee,
				account: wallet.signer,
			};

			// Estimation runs the call in the EVM, so it is also the validity
			// check: bad weights, a disabled market, or an unaffordable dev buy
			// surface here rather than as a reverted transaction.
			let gas = FALLBACK_GAS;
			let projectToken = null;
			let gasPrice = 0n;
			try {
				// These three are independent reads of the same pending state, so
				// they go out together rather than as three sequential round
				// trips. Simulation stays the validity check; estimation gives the
				// limit; the price is needed either way.
				const [sim, estimated, price] = await Promise.all([
					publicClient.simulateContract({ ...call, chain }),
					publicClient.estimateContractGas(call),
					publicClient.getGasPrice(),
				]);
				projectToken = sim.result ? String(sim.result).toLowerCase() : null;
				gas = estimated;
				gasPrice = price;
			} catch (err) {
				if (revertSelector(err) === STALE_PRICE_SELECTOR) {
					if (dryRun) warnings.push('simulation failed: PAIR oracle is stale');
					else throw oracleStale(`a paired market's feed, ${selection.markets.map((m) => m.symbol).join('/')}`);
				}
				const reason = shortError(err);
				if (dryRun) warnings.push(`simulation failed: ${reason}`);
				else throw new Error(`PAIR launch simulation failed: ${reason}`);
			}
			if (gasPrice === 0n) gasPrice = await publicClient.getGasPrice();

			// The limit carries a safety buffer, but the EVM refunds every unit
			// the call does not burn, so the buffer is never actually paid.
			// Budgeting against the buffered limit made each launch look ~15%
			// more expensive than it is and stopped the relay early; the budget
			// therefore uses the estimate and the limit stays generous.
			const gasLimit = (gas * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
			const gasCost = gas * gasPrice;
			const total = launchFee + gasCost;

			return {
				target: 'pairfund',
				chain: chain.name,
				chainId: chain.id,
				spec,
				wallet: wallet.address,
				contract: launchpad,
				cost: {
					nativeSymbol: 'ETH',
					feeNative: formatEther(launchFee),
					gasNative: formatEther(gasCost),
					totalNative: formatEther(total),
					totalBase: total,
				},
				warnings,
				dryRun,
				call: { ...call, gas: gasLimit, deadline, projectToken },
				markets: selection,
				metadata: { metadataURI, metadataHash, imageUrl },
				summary: summarize({ spec, selection, wallet, launchpad, chain, launchFee, gasCost, total, devBuy, metadataURI }),
			};
		},

		/**
		 * @param {import('../../types.js').LaunchPlan} plan
		 * @param {{wallet: import('../../types.js').WalletHandle, log: import('../../types.js').Logger}} ctx
		 */
		async execute(plan, { wallet, log }) {
			if (plan.dryRun) throw new Error('cannot execute a dry-run plan; build a live plan first');
			if (wallet.address.toLowerCase() !== String(plan.wallet).toLowerCase()) {
				throw new Error(`plan was priced for ${plan.wallet}, not ${wallet.address}`);
			}
			const nowSec = BigInt(Math.floor(Date.now() / 1000));
			if (plan.call.deadline <= nowSec + 30n) {
				throw new Error('plan deadline has passed; re-plan rather than sending a stale launch');
			}

			const publicClient = wallet.publicClient;
			// Re-simulate immediately before signing. Between planning and
			// confirmation someone else may have moved the pool or the launch fee
			// may have changed, and a revert caught here costs nothing.
			const sim = await publicClient.simulateContract({
				address: plan.call.address,
				abi: plan.call.abi,
				functionName: plan.call.functionName,
				args: plan.call.args,
				value: plan.call.value,
				account: wallet.signer,
				chain,
			});

			const hash = await wallet.client.writeContract({
				...sim.request,
				account: wallet.signer,
				chain,
				gas: plan.call.gas,
			});
			log.info(`launch tx sent ${hash}`);

			const receipt = await publicClient.waitForTransactionReceipt({ hash });
			if (receipt.status !== 'success') {
				return { ok: false, txHash: hash, url: txUrl(hash), error: 'transaction reverted on chain' };
			}

			// PAIR's indexer resolves the token address from the receipt; the
			// simulated return value is the fallback when the API is slow.
			const registered = await api.registerLaunch(hash).catch(() => null);
			const resolved = registered || sim.result || null;
			const tokenAddress = resolved ? String(resolved).toLowerCase() : null;

			return {
				ok: true,
				txHash: hash,
				tokenAddress,
				url: tokenAddress ? `${api.baseUrl}/tokens/${tokenAddress}` : txUrl(hash),
				explorerUrl: txUrl(hash),
				tokenExplorerUrl: tokenAddress ? addressUrl(tokenAddress) : null,
				gasUsed: receipt.gasUsed,
			};
		},
	};
}

// A dry run still needs a well-formed URI and a hash of the real descriptor so
// the simulated call is the same shape as the live one, minus the upload.
function previewMetadata(baseUrl, spec) {
	const descriptor = {
		name: spec.name,
		symbol: spec.symbol,
		description: spec.description,
		image: spec.imageUrl || undefined,
		links: {
			twitter: spec.links?.twitter || undefined,
			telegram: spec.links?.telegram || undefined,
			website: spec.links?.website || undefined,
		},
	};
	const hash = keccak256(toBytes(JSON.stringify(descriptor)));
	return { metadataURI: `${baseUrl}/api/metadata/${hash.slice(2)}`, metadataHash: hash };
}

/**
 * Developer buy is opt-in and validated hard. Every field must be present
 * together: a buy with an amount but no market index is a misconfiguration
 * that would otherwise spend against pool zero.
 */
function normalizeDevBuy(hint, markets, warnings) {
	if (!hint || !hint.tokenAmountOut) {
		// Disabled means index 255, not index 0. See NO_DEVELOPER_BUY.
		return { enabled: false, recipient: null, pairIndex: NO_DEVELOPER_BUY, tokenAmountOut: 0n, maxQuoteIn: 0n };
	}
	const pairIndex = Number(hint.pairIndex ?? 0);
	if (!Number.isInteger(pairIndex) || pairIndex < 0 || pairIndex >= markets.length) {
		throw new Error(`devBuy.pairIndex ${pairIndex} is outside the ${markets.length} selected markets`);
	}
	const tokenAmountOut = BigInt(hint.tokenAmountOut);
	const maxQuoteIn = BigInt(hint.maxQuoteIn ?? 0);
	if (tokenAmountOut <= 0n) throw new Error('devBuy.tokenAmountOut must be positive');
	if (maxQuoteIn <= 0n) throw new Error('devBuy.maxQuoteIn must be positive; it is the spend ceiling');
	warnings.push(
		`developer buy enabled: up to ${maxQuoteIn} base units of ${markets[pairIndex].symbol} for ${tokenAmountOut} tokens. The wallet must already hold that stock token and have approved the launchpad.`,
	);
	return { enabled: true, recipient: hint.recipient || null, pairIndex, tokenAmountOut, maxQuoteIn };
}

function summarize({ spec, selection, wallet, launchpad, chain, launchFee, gasCost, total, devBuy, metadataURI }) {
	const pools = selection.markets
		.map((m) => `${m.symbol} ${(m.weightBps / BPS_TOTAL * 100).toFixed(2)}%`)
		.join(', ');
	return [
		`launchpad   PAIR V5 ${launchpad} on ${chain.name} (chain ${chain.id})`,
		`token       ${spec.name} (${spec.symbol}), fixed supply ${PAIR_TOTAL_SUPPLY.toLocaleString('en-US')}`,
		`pools       ${pools}`,
		`why         ${selection.rationale}`,
		`from wallet ${wallet.address} (${wallet.label})`,
		`launch fee  ${formatEther(launchFee)} ETH`,
		`gas budget  ${formatEther(gasCost)} ETH`,
		`total       ${formatEther(total)} ETH`,
		`dev buy     ${devBuy.enabled ? `yes, market index ${devBuy.pairIndex}` : 'none'}`,
		`metadata    ${metadataURI}`,
		`origin      ${spec.origin.source} ${spec.origin.address || ''}`.trim(),
	];
}

function shortError(err) {
	const msg = err?.shortMessage || err?.details || err?.message || String(err);
	return String(msg).split('\n')[0].slice(0, 220);
}
