// A launch target for any venue in the Robinhood Chain catalog.
//
// One adapter drives every launchpad discovery found, because the thing that
// differs between them (the ABI of one function) is data, and the thing that
// does not (price it, show it, simulate it, sign it, find the token in the
// receipt) is code. Adding a venue is a catalog entry, not a file.
//
// The split between `plan` and `execute` is the safety boundary, and it is
// stricter here than for a hand-written adapter because more of the call is
// inherited rather than authored:
//
//   plan     builds the calldata, publishes metadata, simulates the call in
//            the EVM, prices gas, and returns something a human can read.
//   execute  re-simulates and signs exactly that. Nothing in between can
//            change what gets sent.
//
// Simulation is not a nicety here, it is the correctness proof for the parts
// of the call this code replayed rather than understood. A replayed argument
// that the venue rejects for this caller reverts in `plan`, before anything is
// signed and before metadata is published anywhere permanent.

import { createPublicClient, encodeFunctionData, formatEther, formatUnits, getAddress, http, parseUnits } from 'viem';
import { addressUrl, robinhoodChain, tokenUrl, txUrl } from './chain.js';
import { erc20Abi } from './amm/abis.js';
import { describeBindings, encodeLaunchCall, verifyDescriptor } from './venues/descriptor.js';
import { requireVenue } from './venues/index.js';
import { inlineMetadataHost } from './metadata.js';

/** Uniswap-style estimates run high on this chain; the EVM refunds the difference. */
const GAS_BUFFER_NUM = 120n;
const GAS_BUFFER_DEN = 100n;
const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEADLINE_SECONDS = 30 * 60;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

/**
 * @param {object} opts
 * @param {string|object} opts.venue          Catalog id, contract address, or a descriptor object.
 * @param {string} [opts.rpcUrl]
 * @param {object} [opts.metadata]            Metadata host adapter. Defaults to inline data URIs.
 * @param {number} [opts.planTtlMs]           How long a plan stays signable. Default 10 minutes.
 * @param {number} [opts.deadlineSeconds]     Validity window written into a venue's deadline field. Default 30 minutes.
 * @param {string} [opts.creator]             Address bound to the venue's creator field. Defaults to the launching wallet.
 * @param {string|number} [opts.buyAmount]   Opening buy, in the venue's quote asset, human units. Venues with a quote only.
 * @param {Record<string, any>} [opts.values] Extra role values, merged over the ones derived from the spec.
 * @param {import('viem').PublicClient} [opts.publicClient]
 * @returns {import('../../types.js').Target}
 */
export function createRobinhoodVenueTarget(opts = {}) {
	const venue = typeof opts.venue === 'object' && opts.venue !== null ? assertDescriptor(opts.venue) : requireVenue(opts.venue);
	const chain = robinhoodChain({ rpcUrl: opts.rpcUrl });
	const metadata = opts.metadata || inlineMetadataHost();
	const planTtlMs = opts.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
	const deadlineSeconds = opts.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
	const bound = new Set((venue.launch.bindings || []).map((b) => b.role));

	const readClient = () =>
		opts.publicClient || createPublicClient({ chain, transport: http(opts.rpcUrl || chain.rpcUrls.default.http[0]) });

	return {
		id: `rhc:${venue.id}`,
		venue,
		chain: chain.name,
		chainId: chain.id,
		nativeSymbol: 'ETH',
		nativeDecimals: 18,
		viemChain: chain,

		async health() {
			const client = readClient();
			const [code, implementation] = await Promise.all([
				client.getCode({ address: getAddress(venue.address) }),
				venue.implementation
					? client.getStorageAt({ address: getAddress(venue.address), slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' }).catch(() => null)
					: Promise.resolve(null),
			]);
			if (!code || code.length <= 2) return { ok: false, detail: `${venue.address} has no code on ${chain.name}` };
			// A proxy upgrade does not change the address, the selector, or the
			// calldata, so nothing else here would notice it. It can absolutely
			// change what the arguments this descriptor replays are read as.
			if (implementation) {
				const live = `0x${implementation.slice(26)}`;
				if (live.toLowerCase() !== String(venue.implementation).toLowerCase()) {
					return {
						ok: false,
						detail: `${venue.id} was upgraded: catalog records implementation ${venue.implementation}, chain reports ${getAddress(live)}. Re-run npm run rhc:discover before launching.`,
					};
				}
			}
			// A recorded live check is a snapshot, not a guarantee, so it warns
			// rather than blocks: a ticker reservation expires, a pause lifts,
			// and `plan` simulates again anyway before anything is signed.
			const note = venue.liveCheck && !venue.liveCheck.ok
				? `. When the catalog was built a launch here reverted: ${venue.liveCheck.reason}`
				: '';
			return { ok: true, detail: `${venue.label || venue.id} at ${venue.address}, ${venue.observed?.launches ?? 0} observed launch(es)${note}` };
		},

		/**
		 * @param {import('../../types.js').LaunchSpec} spec
		 * @param {{wallet: import('../../types.js').WalletHandle, log: import('../../types.js').Logger, dryRun?: boolean}} ctx
		 */
		async plan(spec, { wallet, log, dryRun = false }) {
			const publicClient = wallet.publicClient || readClient();
			const warnings = [];

			const published = bound.has('metadataUri') || bound.has('metadataHash')
				? await metadata.publish(spec)
				: { metadataURI: null, metadataHash: null, imageUrl: spec.imageUrl || null };
			if (bound.has('metadataUri') && !published.metadataURI) {
				throw new Error(`${venue.id} requires a metadata URI and the "${metadata.id}" host returned none`);
			}

			const values = {
				name: spec.name,
				symbol: spec.symbol,
				description: spec.description || '',
				imageUrl: published.imageUrl || spec.imageUrl || '',
				metadataUri: published.metadataURI,
				metadataHash: published.metadataHash,
				twitter: spec.links?.twitter || '',
				telegram: spec.links?.telegram || '',
				website: spec.links?.website || '',
				discord: spec.links?.discord || '',
				creator: opts.creator || wallet.address,
				salt: randomSalt(),
				// Generous on purpose: a plan may sit in a Telegram message
				// waiting for a human, and a deadline that expires while
				// somebody reads it turns an approval into a revert.
				deadline: Math.floor(Date.now() / 1000) + deadlineSeconds,
				...(opts.values || {}),
				...(spec.targetHints?.values || {}),
			};
			for (const role of ['name', 'symbol']) {
				if (!bound.has(role)) warnings.push(`this venue's calldata has no field recognised as the ${role}; it will launch under the anchor transaction's ${role}`);
			}
			for (const [role, value] of Object.entries({ twitter: values.twitter, telegram: values.telegram, website: values.website })) {
				if (value && !bound.has(role)) warnings.push(`${venue.id} takes no ${role} field, so that link will not appear on the token`);
			}

			// A venue that takes an opening buy pulls it from the wallet as an
			// ERC-20, so it needs an allowance the launch transaction cannot
			// grant itself. Working that out here, before signing, is the
			// difference between a clear message and a revert nobody can read.
			const buy = resolveBuy({ venue, opts, spec, bound });
			if (buy.amount > 0n) values.buyAmount = buy.amount.toString();

			const call = encodeLaunchCall(venue, values);
			const preSteps = [];
			if (buy.amount > 0n && venue.quote?.token) {
				const [balance, allowance] = await Promise.all([
					publicClient.readContract({ address: getAddress(venue.quote.token), abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] }),
					publicClient.readContract({ address: getAddress(venue.quote.token), abi: erc20Abi, functionName: 'allowance', args: [wallet.address, getAddress(venue.address)] }),
				]);
				if (balance < buy.amount) {
					throw new Error(`${venue.id} opening buy needs ${formatUnits(buy.amount, buy.decimals)} ${buy.symbol} but the wallet holds ${formatUnits(balance, buy.decimals)}`);
				}
				if (allowance < buy.amount) {
					preSteps.push({
						label: `approve ${venue.label || venue.id} to spend ${formatUnits(buy.amount, buy.decimals)} ${buy.symbol}`,
						to: getAddress(venue.quote.token),
						value: 0n,
						data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [getAddress(venue.address), buy.amount] }),
					});
					warnings.push(`the launch is preceded by one approval transaction for ${buy.symbol}`);
				}
			}
			const spread = venue.launch.valueObserved;
			if (spread && BigInt(spread.max) > BigInt(spread.min)) {
				warnings.push(`launches here have paid between ${formatEther(BigInt(spread.min))} and ${formatEther(BigInt(spread.max))} ETH; this plan pays the floor, which excludes any creator buy`);
			}

			let gas;
			let simulated = null;
			let gasPrice;
			try {
				const [sim, estimate, price] = await Promise.all([
					publicClient.simulateContract({ ...call, account: wallet.signer, chain }),
					publicClient.estimateContractGas({ ...call, account: wallet.signer }),
					publicClient.getGasPrice(),
				]);
				simulated = sim.result ?? null;
				gas = estimate;
				gasPrice = price;
			} catch (err) {
				const reason = short(err);
				// A launch that spends an ERC-20 cannot simulate until the
				// allowance exists, and the allowance is the step before it. In
				// that one case a failed simulation is expected rather than
				// disqualifying, and the approval is what resolves it.
				if (!dryRun && !preSteps.length) throw new Error(`${venue.id} launch simulation failed: ${reason}`);
				warnings.push(preSteps.length
					? `simulation could not run before the ${buy.symbol} approval lands: ${reason}`
					: `simulation failed: ${reason}`);
				gas = 3_000_000n;
				gasPrice = await publicClient.getGasPrice();
			}

			const gasCost = gas * gasPrice;
			const total = call.value + gasCost;
			const projectToken = typeof simulated === 'string' && simulated.startsWith('0x') && simulated.length === 42
				? getAddress(simulated)
				: null;

			return {
				target: `rhc:${venue.id}`,
				chain: chain.name,
				chainId: chain.id,
				spec,
				wallet: wallet.address,
				contract: venue.address,
				cost: {
					nativeSymbol: 'ETH',
					feeNative: formatEther(call.value),
					gasNative: formatEther(gasCost),
					totalNative: formatEther(total),
					totalBase: total,
				},
				warnings,
				dryRun,
				plannedAt: Date.now(),
				preSteps,
				buy: buy.amount > 0n ? { amount: buy.amount.toString(), symbol: buy.symbol, decimals: buy.decimals, token: venue.quote?.token || null } : null,
				call: {
					address: call.address,
					abi: call.abi,
					functionName: call.functionName,
					args: call.args,
					value: call.value,
					data: call.data,
					gas: (gas * GAS_BUFFER_NUM) / GAS_BUFFER_DEN,
					projectToken,
				},
				metadata: published,
				venue: { id: venue.id, label: venue.label, kind: venue.kind, address: venue.address },
				summary: summarize({ venue, spec, wallet, call, gasCost, total, metadata: published, buy, preSteps }),
			};
		},

		/**
		 * @param {object} plan
		 * @param {{wallet: import('../../types.js').WalletHandle, log: import('../../types.js').Logger}} ctx
		 */
		async execute(plan, { wallet, log }) {
			if (plan.dryRun) throw new Error('cannot execute a dry-run plan; build a live plan first');
			if (wallet.address.toLowerCase() !== String(plan.wallet).toLowerCase()) {
				throw new Error(`plan was priced for ${plan.wallet}, not ${wallet.address}`);
			}
			// A learned descriptor is only as good as the state it was priced
			// against. Rather than trust an old plan, refuse it: re-planning is
			// cheap and a stale launch is not.
			if (Date.now() - (plan.plannedAt ?? 0) > planTtlMs) {
				throw new Error(`plan is older than ${Math.round(planTtlMs / 1000)}s; re-plan rather than signing a stale launch`);
			}

			const publicClient = wallet.publicClient || readClient();

			for (const step of plan.preSteps || []) {
				const gas = await publicClient.estimateGas({ account: wallet.signer, to: step.to, data: step.data, value: step.value || 0n });
				const hash = await wallet.client.sendTransaction({ account: wallet.signer, chain, to: step.to, data: step.data, value: step.value || 0n, gas: (gas * 125n) / 100n });
				log.info(`${step.label} sent ${hash}`);
				const receipt = await publicClient.waitForTransactionReceipt({ hash });
				if (receipt.status !== 'success') {
					return { ok: false, txHash: hash, url: txUrl(hash), error: `"${step.label}" reverted on chain` };
				}
			}

			const sim = await publicClient.simulateContract({
				address: plan.call.address,
				abi: plan.call.abi,
				functionName: plan.call.functionName,
				args: plan.call.args,
				value: plan.call.value,
				account: wallet.signer,
				chain,
			});

			const hash = await wallet.client.writeContract({ ...sim.request, account: wallet.signer, chain, gas: plan.call.gas });
			log.info(`launch tx sent ${hash}`);

			const receipt = await publicClient.waitForTransactionReceipt({ hash });
			if (receipt.status !== 'success') {
				return { ok: false, txHash: hash, url: txUrl(hash), error: 'transaction reverted on chain' };
			}

			// Whatever the venue returns, the token is the contract that minted
			// its supply from the zero address in this receipt. That holds for
			// every ERC-20 ever deployed, which makes it the one way to resolve
			// the address that does not need to know the venue.
			const tokenAddress = mintedToken(receipt) || plan.call.projectToken || null;
			return {
				ok: true,
				txHash: hash,
				tokenAddress,
				url: tokenAddress ? tokenUrl(tokenAddress) : txUrl(hash),
				explorerUrl: txUrl(hash),
				tokenExplorerUrl: tokenAddress ? addressUrl(tokenAddress) : null,
				gasUsed: receipt.gasUsed,
			};
		},
	};
}

/** The ERC-20 in a receipt that minted supply from nothing. */
export function mintedToken(receipt) {
	for (const log of receipt.logs || []) {
		if (log.topics?.[0] !== TRANSFER_TOPIC) continue;
		if (log.topics.length !== 3 || log.topics[1] !== ZERO_TOPIC) continue;
		if (!log.data || log.data === '0x') continue;
		return getAddress(log.address);
	}
	return null;
}

function assertDescriptor(descriptor) {
	const check = verifyDescriptor(descriptor);
	if (!check.ok) throw new Error(`venue descriptor is not usable: ${check.reason}`);
	return descriptor;
}

function randomSalt() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * How much of the venue's quote asset this launch opens with.
 *
 * The default is whatever the anchor paid, which for every venue in the
 * catalog is the floor anyone paid. A caller can raise it; nothing raises it
 * on their behalf.
 */
function resolveBuy({ venue, opts, spec, bound }) {
	const decimals = venue.quote?.decimals ?? 18;
	const symbol = venue.quote?.symbol || 'quote';
	if (!bound.has('buyAmount')) return { amount: 0n, decimals, symbol };
	const requested = spec.targetHints?.buyAmount ?? opts.buyAmount;
	if (requested !== undefined && requested !== null) {
		return { amount: parseUnits(String(requested), decimals), decimals, symbol };
	}
	// Zero by default, never the anchor's. An opening buy spends the caller's
	// money on their own token, and inheriting one from whoever happened to
	// launch on this venue first is not a default, it is an accident.
	return { amount: 0n, decimals, symbol };
}

function summarize({ venue, spec, wallet, call, gasCost, total, metadata, buy, preSteps }) {
	const lines = [
		`launchpad   ${venue.label || venue.id} ${venue.address} on Robinhood Chain (chain 4663)`,
		`function    ${venue.launch.signature}`,
		`token       ${spec.name} (${spec.symbol})`,
		`from wallet ${wallet.address} (${wallet.label})`,
		`launch fee  ${formatEther(call.value)} ETH`,
		`gas budget  ${formatEther(gasCost)} ETH`,
		`total       ${formatEther(total)} ETH`,
	];
	if (buy?.amount > 0n) lines.push(`opening buy ${formatUnits(buy.amount, buy.decimals)} ${buy.symbol}${preSteps?.length ? ' (one approval transaction first)' : ''}`);
	if (metadata?.metadataURI) lines.push(`metadata    ${truncate(metadata.metadataURI, 96)}`);
	lines.push(...describeBindings(venue).map((line) => `  ${line}`));
	lines.push(`origin      ${spec.origin?.source || 'manual'} ${spec.origin?.address || ''}`.trim());
	return lines;
}

const truncate = (value, max) => (value.length > max ? `${value.slice(0, max - 3)}...` : value);
const short = (err) => String(err?.shortMessage || err?.details || err?.message || err).split('\n')[0].slice(0, 220);
