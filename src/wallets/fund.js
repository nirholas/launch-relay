// Spreading funds across the pool.
//
// Rotation only works if every wallet can pay. Bridging to five addresses by
// hand is tedious and error-prone, so this takes one funded wallet and levels
// the rest from it.
//
// It is a transfer, so it plans and executes as two steps like every other
// spend in this tool: the caller sees exactly what will move before anything
// is signed.

import { formatEther, parseEther } from 'viem';

/**
 * Work out the transfers needed to bring every wallet up to a target balance.
 *
 * Wallets already at or above the target are skipped rather than topped up by
 * zero, and the source keeps a gas reserve so it cannot strand itself paying
 * for the last transfer.
 *
 * @param {object} opts
 * @param {import('../types.js').WalletPool} opts.wallets
 * @param {string} opts.target        Target balance per wallet, in whole native units.
 * @param {string} [opts.reserve]     Left in the source wallet. Default '0.001'.
 * @param {string} [opts.from]        Source address. Defaults to the richest wallet.
 * @returns {Promise<{from: object, transfers: object[], totalWei: bigint, shortfallWei: bigint, summary: string[]}>}
 */
export async function planFunding({ wallets, target, reserve = '0.001', from }) {
	const targetWei = parseEther(String(target));
	const reserveWei = parseEther(String(reserve));
	const handles = wallets.list();
	if (handles.length < 2) throw new Error('funding needs at least two wallets in the pool');

	const balances = new Map();
	for (const handle of handles) balances.set(handle.address, await handle.balance());

	const source = from
		? handles.find((h) => h.address.toLowerCase() === String(from).toLowerCase())
		: [...handles].sort((a, b) => (balances.get(b.address) > balances.get(a.address) ? 1 : -1))[0];
	if (!source) throw new Error(`wallet ${from} is not in the pool`);

	const transfers = [];
	let totalWei = 0n;
	for (const handle of handles) {
		if (handle.address === source.address) continue;
		const have = balances.get(handle.address) ?? 0n;
		if (have >= targetWei) continue;
		const amount = targetWei - have;
		transfers.push({ to: handle.address, label: handle.label, amount, have });
		totalWei += amount;
	}

	const sourceBalance = balances.get(source.address) ?? 0n;
	const spendable = sourceBalance > reserveWei ? sourceBalance - reserveWei : 0n;
	const shortfallWei = totalWei > spendable ? totalWei - spendable : 0n;

	return {
		from: { address: source.address, label: source.label, balance: sourceBalance },
		transfers,
		totalWei,
		shortfallWei,
		summary: [
			`source      ${source.address} (${source.label}) holding ${fmt(sourceBalance)} ETH`,
			`target      ${target} ETH in each of ${handles.length - 1} other wallet(s)`,
			`transfers   ${transfers.length}: ${transfers.map((t) => `${t.label} +${fmt(t.amount)}`).join(', ') || 'none needed'}`,
			`total       ${fmt(totalWei)} ETH, keeping ${reserve} ETH as gas reserve`,
			shortfallWei > 0n ? `SHORTFALL   ${fmt(shortfallWei)} ETH more is needed in the source wallet` : '',
		].filter(Boolean),
	};
}

/**
 * Send the transfers. Sequential, and it stops on the first failure: a partial
 * spread is recoverable, a runaway loop of failed sends is not.
 *
 * @param {object} opts
 * @param {object} opts.plan          From planFunding.
 * @param {import('../types.js').WalletPool} opts.wallets
 * @param {import('viem').Chain} opts.chain
 * @param {import('../types.js').Logger} opts.log
 */
export async function executeFunding({ plan, wallets, chain, log }) {
	if (plan.shortfallWei > 0n) {
		throw new Error(`source wallet is short by ${fmt(plan.shortfallWei)} ETH; fund it first`);
	}
	const source = wallets.list().find((h) => h.address === plan.from.address);
	if (!source) throw new Error('source wallet vanished from the pool');

	const results = [];
	for (const transfer of plan.transfers) {
		const hash = await source.client.sendTransaction({
			account: source.signer,
			chain,
			to: transfer.to,
			value: transfer.amount,
		});
		const receipt = await source.publicClient.waitForTransactionReceipt({ hash });
		const ok = receipt.status === 'success';
		log.info(`${ok ? 'sent' : 'FAILED'} ${fmt(transfer.amount)} ETH to ${transfer.label} ${transfer.to} (${hash})`);
		results.push({ ...transfer, txHash: hash, ok });
		if (!ok) throw new Error(`transfer to ${transfer.to} reverted; stopping before the rest`);
	}
	return results;
}

const fmt = (wei) => {
	const s = formatEther(wei);
	return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
