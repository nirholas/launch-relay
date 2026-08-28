// Creator fees.
//
// Every PAIR token pays its creator a share of swap fees, and those fees do not
// arrive in a wallet: they accumulate inside the locked Uniswap V4 position,
// get swept by PAIR's keeper, and then sit in a locker until the creator claims
// them. An autonomous launcher that never claims is leaving its own revenue on
// the floor, which is why this is part of the tool and not an afterthought.
//
// Discovery goes through PAIR's API because it already knows which of the three
// historical lockers holds a given balance and which asset address to pass.
// The claim itself is a direct contract call: the API tells us where the money
// is, the chain is where we go get it.

import { formatUnits } from 'viem';
import { PAIR_V4_LOCKER, lockerAbi } from './abi.js';
import { txUrl } from './chain.js';

/**
 * @typedef {object} ClaimableFee
 * @property {string} symbol
 * @property {string} assetAddress   Argument for the locker's claim call.
 * @property {string} lockerAddress
 * @property {bigint} amount
 * @property {number} decimals
 * @property {string} amountFormatted
 * @property {number|null} amountUsd
 * @property {string} assetType      'PROJECT' when the fee accrued in the launched token, else the stock token.
 */

/**
 * Everything this wallet can claim right now, across every locker PAIR has
 * used. Rows with a zero balance are dropped: they are noise in a report and a
 * wasted transaction if claimed.
 *
 * @param {object} api    A PAIR API client.
 * @param {string} wallet
 * @returns {Promise<ClaimableFee[]>}
 */
export async function fetchClaimable(api, wallet) {
	const rows = await api.feesClaimable(wallet);
	return (Array.isArray(rows) ? rows : [])
		.map((row) => {
			const decimals = row?.quoteToken?.decimals ?? 18;
			const amount = toBigInt(row?.claimableAmount);
			return {
				symbol: row?.quoteToken?.symbol || 'UNKNOWN',
				assetAddress: row?.claimAssetAddress || row?.quoteToken?.address,
				lockerAddress: row?.lockerAddress || PAIR_V4_LOCKER,
				amount,
				decimals,
				amountFormatted: trimZeros(formatUnits(amount, decimals)),
				amountUsd: numOrNull(row?.claimableAmountUsd),
				assetType: row?.assetType || 'QUOTE',
				projectTokenAddress: row?.projectTokenAddress || null,
			};
		})
		.filter((row) => row.amount > 0n && row.assetAddress);
}

/**
 * Fees that exist but are not claimable yet: still sitting inside the LP
 * position, waiting for the keeper's next sweep. Reported separately so a zero
 * claimable balance is not mistaken for zero earnings.
 */
export async function fetchPending(api, wallet) {
	const rows = await api.feesPending(wallet);
	return (Array.isArray(rows) ? rows : []).map((row) => ({
		symbol: row?.quoteToken?.symbol || row?.symbol || 'UNKNOWN',
		amount: toBigInt(row?.pendingAmount ?? row?.amount),
		decimals: row?.quoteToken?.decimals ?? 18,
		amountUsd: numOrNull(row?.pendingAmountUsd ?? row?.amountUsd),
		tokenAddress: row?.tokenAddress || row?.projectTokenAddress || null,
	}));
}

/**
 * Price a batch of claims without sending them.
 *
 * Claiming is one transaction per asset, and each one costs gas. On a chain
 * this cheap that rarely matters, but a claim whose gas exceeds the balance it
 * recovers is still a loss, so the plan says so and the caller decides.
 *
 * @param {object} opts
 * @param {ClaimableFee[]} opts.rows
 * @param {import('../../types.js').WalletHandle} opts.wallet
 * @returns {Promise<{claims: object[], totalGas: bigint, gasPrice: bigint, summary: string[]}>}
 */
export async function planClaims({ rows, wallet }) {
	const publicClient = wallet.publicClient;
	const gasPrice = await publicClient.getGasPrice();
	const claims = [];
	let totalGas = 0n;

	for (const row of rows) {
		const call = {
			address: row.lockerAddress,
			abi: lockerAbi,
			functionName: 'claim',
			args: [row.assetAddress],
			account: wallet.signer,
		};
		let gas = 200_000n;
		let simulated = true;
		try {
			gas = (await publicClient.estimateContractGas(call) * 120n) / 100n;
		} catch {
			// A claim that will not simulate is usually a balance the keeper has
			// already swept out from under the API's cached view. Keep it in the
			// batch, flagged, rather than silently dropping a real balance.
			simulated = false;
		}
		totalGas += gas;
		claims.push({ ...row, call, gas, gasCost: gas * gasPrice, simulated });
	}

	return {
		claims,
		totalGas,
		gasPrice,
		summary: [
			`wallet      ${wallet.address} (${wallet.label})`,
			`claims      ${claims.length} asset(s): ${claims.map((c) => `${c.amountFormatted} ${c.symbol}`).join(', ') || 'none'}`,
			`locker      ${claims[0]?.lockerAddress || PAIR_V4_LOCKER}`,
			`gas budget  ${trimZeros(formatUnits(totalGas * gasPrice, 18))} ETH across ${claims.length} transaction(s)`,
		],
	};
}

/**
 * Send the claims. One transaction per asset, sequential, and it does not stop
 * the batch when one fails: an asset whose balance moved should not cost you
 * the other three.
 *
 * @param {object} opts
 * @param {object[]} opts.claims  From planClaims.
 * @param {import('../../types.js').WalletHandle} opts.wallet
 * @param {import('viem').Chain} opts.chain
 * @param {import('../../types.js').Logger} opts.log
 */
export async function executeClaims({ claims, wallet, chain, log }) {
	const results = [];
	for (const claim of claims) {
		try {
			const { request } = await wallet.publicClient.simulateContract({ ...claim.call, chain });
			const hash = await wallet.client.writeContract({ ...request, account: wallet.signer, chain });
			const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
			const ok = receipt.status === 'success';
			log.info(`${ok ? 'claimed' : 'claim reverted'} ${claim.amountFormatted} ${claim.symbol} ${txUrl(hash)}`);
			results.push({ symbol: claim.symbol, amount: claim.amount, ok, txHash: hash, url: txUrl(hash) });
		} catch (err) {
			const detail = err?.shortMessage || err?.message || String(err);
			log.warn(`claim failed for ${claim.symbol}: ${detail}`);
			results.push({ symbol: claim.symbol, amount: claim.amount, ok: false, error: detail });
		}
	}
	return results;
}

const toBigInt = (v) => {
	if (typeof v === 'bigint') return v;
	const s = String(v ?? '0').trim();
	return /^\d+$/.test(s) ? BigInt(s) : 0n;
};
const numOrNull = (v) => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const trimZeros = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
