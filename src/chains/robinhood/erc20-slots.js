// Finding where an ERC-20 keeps its balances, without being told.
//
// Discovery proves a venue by simulating a launch on it. A launchpad whose
// entry point takes an opening buy pulls an ERC-20 from the caller, and the
// probe account holds nothing, so those venues revert with an allowance error
// and get written off as unlaunchable. They are not: they are launchable by
// anyone holding the quote asset, which is most of their real users.
//
// A state override can give the probe that balance, but only if we know which
// storage slot the token keeps balances in, and that is a compiler detail no
// interface exposes. So it is measured rather than assumed. Solidity maps
// `mapping(address => uint256)` at slot `s` to `keccak256(holder . s)`. Write a
// recognisable value to that key for each candidate `s`, ask the token what
// the holder's balance is, and the slot that answers with the written value is
// the balance slot. Same shape one level deeper for the allowance mapping.
//
// This is measurement, not guesswork: a wrong slot simply does not answer, and
// a token whose layout does not match any candidate is reported as unknown
// rather than approximated.

import { encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toHex } from 'viem';

const abi = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function decimals() view returns (uint8)',
]);

/** How many leading storage slots to try before giving up. */
const MAX_SLOT = 32;

/** A value unlikely to appear by accident, so a match is a match. */
const SENTINEL = 0x5eed_1234_5eed_1234n;

const cache = new Map();

/**
 * Storage key of `mapping(address => T)` at slot `slot`, for `holder`.
 *
 * @param {string} holder
 * @param {number} slot
 */
export function mappingSlot(holder, slot) {
	return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(slot)]));
}

/**
 * Storage key of `mapping(address => mapping(address => T))` at `slot`.
 *
 * @param {string} owner
 * @param {string} spender
 * @param {number} slot
 */
export function nestedMappingSlot(owner, spender, slot) {
	const outer = mappingSlot(owner, slot);
	return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, outer]));
}

/**
 * Work out an ERC-20's balance and allowance slots by writing to candidates
 * and reading the result back through the token's own accessors.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {string} opts.token
 * @param {string} opts.holder   Any address; nothing is written on chain.
 * @param {string} opts.spender
 * @param {number} [opts.maxSlot]
 * @returns {Promise<{balanceSlot: number|null, allowanceSlot: number|null}>}
 */
export async function findErc20Slots({ client, token, holder, spender, maxSlot = MAX_SLOT }) {
	const key = token.toLowerCase();
	if (cache.has(key)) return cache.get(key);

	const value = pad(toHex(SENTINEL), { size: 32 });
	let balanceSlot = null;
	let allowanceSlot = null;

	for (let slot = 0; slot < maxSlot && balanceSlot === null; slot++) {
		const answered = await reads(client, token, 'balanceOf', [holder], [
			{ address: token, stateDiff: [{ slot: mappingSlot(holder, slot), value }] },
		]);
		if (answered === SENTINEL) balanceSlot = slot;
	}
	for (let slot = 0; slot < maxSlot && allowanceSlot === null; slot++) {
		const answered = await reads(client, token, 'allowance', [holder, spender], [
			{ address: token, stateDiff: [{ slot: nestedMappingSlot(holder, spender, slot), value }] },
		]);
		if (answered === SENTINEL) allowanceSlot = slot;
	}

	const found = { balanceSlot, allowanceSlot };
	cache.set(key, found);
	return found;
}

async function reads(client, token, functionName, args, stateOverride) {
	try {
		const { data } = await client.call({
			to: token,
			data: encodeFunctionData({ abi, functionName, args }),
			stateOverride,
		});
		return data && data !== '0x' ? BigInt(data) : null;
	} catch {
		return null;
	}
}

/**
 * State overrides that make `holder` rich in `token` and fully approved to
 * `spender`, for the duration of one simulated call.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {string} opts.token
 * @param {string} opts.holder
 * @param {string} opts.spender
 * @param {bigint} [opts.amount]
 * @returns {Promise<Array<object>>} empty when the token's layout could not be measured
 */
export async function fundOverride({ client, token, holder, spender, amount = 2n ** 96n }) {
	const { balanceSlot, allowanceSlot } = await findErc20Slots({ client, token, holder, spender });
	const value = pad(toHex(amount), { size: 32 });
	const stateDiff = [];
	if (balanceSlot !== null) stateDiff.push({ slot: mappingSlot(holder, balanceSlot), value });
	if (allowanceSlot !== null) stateDiff.push({ slot: nestedMappingSlot(holder, spender, allowanceSlot), value });
	return stateDiff.length ? [{ address: token, stateDiff }] : [];
}

/** Whether an address answers like an ERC-20 at all. */
export async function isErc20(client, address) {
	const decimals = await reads(client, address, 'decimals', [], undefined);
	return decimals !== null && decimals <= 36n;
}

/** Reset the measured-layout cache. Tests use this; nothing else needs to. */
export function clearSlotCache() {
	cache.clear();
}
