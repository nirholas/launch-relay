// The Robinhood Chain venue registry.
//
// One place to ask "what can I launch on, and how". Everything in it was
// learned from the chain by src/chains/robinhood/discover.js and re-verified
// against the transaction it was learned from before being served, so a
// descriptor that has rotted between the catalog being written and being read
// is refused here rather than at signing time.

import catalog from './catalog.json' with { type: 'json' };
import { verifyDescriptor } from './descriptor.js';
import { KNOWN_VENUES } from './labels.js';

export { catalog };
export { KNOWN_VENUES };

/** When the shipped catalog was generated, and over which blocks. */
export const CATALOG_META = Object.freeze({
	generatedAt: catalog.generatedAt,
	window: catalog.window,
	tokensScanned: catalog.tokensScanned,
	chainId: catalog.chainId,
});

const VENUES = Object.freeze(catalog.venues.map(Object.freeze));

/**
 * Every venue discovery found, usable or not.
 *
 * @param {{kind?: string, usable?: boolean, minLaunches?: number, live?: boolean}} [filter]
 * @returns {ReadonlyArray<object>}
 */
export function listVenues(filter = {}) {
	return VENUES.filter((venue) => {
		if (filter.kind && venue.kind !== filter.kind) return false;
		if (filter.usable !== undefined && Boolean(venue.usable) !== filter.usable) return false;
		if (filter.minLaunches && (venue.observed?.launches ?? 0) < filter.minLaunches) return false;
		// `live` is the strongest filter available: it selects venues whose
		// launch was actually executed against chain state when the catalog was
		// built, rather than venues that merely encode.
		if (filter.live !== undefined && Boolean(venue.liveCheck?.ok) !== filter.live) return false;
		return true;
	});
}

/**
 * Look a venue up by id or by contract address, case-insensitively.
 *
 * @param {string} idOrAddress
 * @returns {object|null}
 */
export function findVenue(idOrAddress) {
	if (!idOrAddress) return null;
	const needle = String(idOrAddress).toLowerCase();
	return VENUES.find((v) => v.id.toLowerCase() === needle || v.address.toLowerCase() === needle) || null;
}

/**
 * Look a venue up and refuse anything a launch cannot be built from. This is
 * the accessor every launch path uses; `findVenue` is for reporting.
 *
 * @param {string} idOrAddress
 * @returns {object}
 */
export function requireVenue(idOrAddress) {
	const venue = findVenue(idOrAddress);
	if (!venue) {
		const known = VENUES.filter((v) => v.usable).map((v) => v.id).join(', ');
		throw new Error(`no Robinhood Chain venue "${idOrAddress}". Launchable venues: ${known}`);
	}
	if (!venue.usable) throw new Error(`venue "${venue.id}" is catalogued but not launchable: ${venue.reason}`);
	const check = verifyDescriptor(venue);
	if (!check.ok) throw new Error(`venue "${venue.id}" failed its own verification: ${check.reason}`);
	return venue;
}

/** The distinct kinds present in the catalog, for grouping in a UI. */
export function venueKinds() {
	return [...new Set(VENUES.map((v) => v.kind))].sort();
}
