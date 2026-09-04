// What we know about a venue that inference cannot see.
//
// Discovery reads meaning out of an anchor transaction by matching values: a
// string equal to the token's name is the name, an address equal to the sender
// is the creator. That covers identity and links and nothing else, because
// nothing else has a value to match against. An amount is just a number.
//
// This file is where a number gets a meaning, and every entry has to say where
// the meaning came from. The bar is a decoded transaction or a published
// interface, not a plausible guess: an override binds a field that a launch
// will then *change*, which is exactly the kind of field that costs money when
// it is wrong. A venue with no entry here still works; it simply replays the
// numbers it was anchored on.

import { TOKENS } from '../contracts.js';

/**
 * @typedef {object} VenueOverride
 * @property {string} [kind]     Replaces the generic 'launchpad'.
 * @property {{token: string, symbol: string, decimals: number}} [quote]
 * @property {Array<{role: string, path: number[], type: string}>} [bindings]
 * @property {{spenderIsVenue?: boolean, amountRole?: string}} [approval]
 * @property {string} reason
 */

/** @type {Record<string, VenueOverride>} */
export const VENUE_OVERRIDES = Object.freeze({
	// Virtuals Protocol bonding curve.
	//
	// preLaunch(string name, string ticker, uint8[] cores, string description,
	//           string image, string[4] urls, uint256 purchaseAmount, ...)
	//
	// Argument 6 is the creator's opening buy, denominated in VIRTUAL and
	// pulled from the launching wallet, which is why it needs an allowance and
	// why it is the one number here worth binding. Two anchors decode to
	// 4556000000000000000000 and 10000000000000000000: eighteen decimals, wildly
	// different sizes, and both matching the VIRTUAL the wallet spent in that
	// transaction. Every agent token launched through this contract quotes
	// against VIRTUAL, which is what identifies the asset.
	'0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007': {
		kind: 'bonding-curve',
		quote: { token: TOKENS.VIRTUAL, symbol: 'VIRTUAL', decimals: 18 },
		bindings: [{ role: 'buyAmount', path: [6], type: 'uint256' }],
		approval: { spenderIsVenue: true, amountRole: 'buyAmount' },
		reason: 'argument 6 of preLaunch is the opening buy in VIRTUAL; it differs across anchors by three orders of magnitude and matches the VIRTUAL leaving the wallet in each',
	},
});

/**
 * Fold an override into a freshly discovered descriptor.
 *
 * Overrides add bindings rather than replacing them, and an override that
 * points outside the anchor's argument tree is dropped instead of applied: a
 * venue that changed its signature should fall back to replaying what worked,
 * not write a caller's number into whatever now sits at that index.
 *
 * @param {object} descriptor
 * @param {(path: number[]) => boolean} pathExists
 * @returns {object}
 */
export function applyOverride(descriptor, pathExists) {
	const override = VENUE_OVERRIDES[descriptor.address?.toLowerCase()];
	if (!override || !descriptor.usable) return descriptor;

	const extra = (override.bindings || []).filter((binding) => {
		if (!pathExists(binding.path)) return false;
		return !(descriptor.launch.bindings || []).some((existing) => existing.path.join('.') === binding.path.join('.'));
	});
	const dropped = (override.bindings || []).length - extra.length;

	return {
		...descriptor,
		kind: override.kind || descriptor.kind,
		quote: override.quote || descriptor.quote || null,
		approval: override.approval || null,
		overrideReason: override.reason,
		overrideDropped: dropped || undefined,
		launch: { ...descriptor.launch, bindings: [...(descriptor.launch.bindings || []), ...extra] },
	};
}

/**
 * Contracts confirmed to be launch entry points despite a function name that
 * does not read like one.
 *
 * `classifyLaunchFunction` refuses to drive a venue whose minting function is
 * named like a router or a bridge, because a token minted from the zero
 * address by `swap()` is far more often an aggregator passing through somebody
 * else's launchpad than a launchpad of its own. That check is deliberately
 * conservative and will sometimes be wrong. This is where being wrong is
 * corrected, one address at a time, with the reason recorded.
 */
export const CONFIRMED_ENTRY_POINTS = new Map();
