// The catalog is generated, so these are the checks that keep a regenerated
// one honest. Every one of them would have caught a real failure mode: a
// descriptor that stopped reproducing its anchor after a hand edit, a venue
// published as launchable with no evidence behind it, a salt left replayed.

import { describe, expect, it } from 'vitest';
import { isAddress } from 'viem';
import { CATALOG_META, catalog, findVenue, listVenues, requireVenue, venueKinds } from '../src/chains/robinhood/venues/index.js';
import { argumentTypes, verifyDescriptor } from '../src/chains/robinhood/venues/descriptor.js';
import { walkLeaves } from '../src/chains/robinhood/discover.js';
import { ROBINHOOD_CHAIN_ID } from '../src/chains/robinhood/chain.js';

const usable = listVenues({ usable: true });

describe('the catalog as a whole', () => {
	it('was generated against Robinhood Chain over a recorded window', () => {
		expect(catalog.chainId).toBe(ROBINHOOD_CHAIN_ID);
		expect(CATALOG_META.generatedAt).toBeTruthy();
		expect(CATALOG_META.window.toBlock).toBeGreaterThan(CATALOG_META.window.fromBlock);
	});

	it('found venues worth publishing', () => {
		expect(catalog.venues.length).toBeGreaterThan(0);
		expect(usable.length).toBeGreaterThan(0);
	});

	it('gives every venue a unique id', () => {
		const ids = catalog.venues.map((v) => v.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('sorts by how many launches were actually observed', () => {
		const counts = catalog.venues.map((v) => v.observed?.launches ?? 0);
		expect([...counts].sort((a, b) => b - a)).toEqual(counts);
	});
});

describe('every launchable venue', () => {
	it.each(usable.map((v) => [v.id, v]))('%s reproduces its anchor transaction', (_id, venue) => {
		expect(verifyDescriptor(venue)).toEqual({ ok: true });
	});

	it.each(usable.map((v) => [v.id, v]))('%s carries the evidence behind it', (_id, venue) => {
		expect(isAddress(venue.address)).toBe(true);
		expect(venue.evidence.txHash).toMatch(/^0x[0-9a-f]{64}$/);
		expect(isAddress(venue.evidence.token)).toBe(true);
		expect(venue.evidence.input.startsWith(venue.selector)).toBe(true);
		expect(venue.observed.launches).toBeGreaterThan(0);
	});

	it.each(usable.map((v) => [v.id, v]))('%s accounts for every opaque bytes32 it carries', (_id, venue) => {
		// A non-zero bytes32 in a launch call is a salt, a hash of the metadata
		// document, or a commitment the contract recomputes. Whichever it is,
		// it must not be silently replayed: either something binds it, or the
		// probe recorded why it could not be changed.
		const types = argumentTypes(venue.launch.signature);
		const opaque = types
			.flatMap((type, i) => [...walkLeaves(venue.launch.template[i], type, [i])])
			.filter((leaf) => leaf.type === 'bytes32' && !/^0x0+$/.test(String(leaf.value)));
		if (!opaque.length) return;
		const bound = venue.launch.bindings.some((b) => b.type === 'bytes32');
		const explained = (venue.probe?.rejected || []).some((r) => r.role === 'salt' || r.role === 'metadataHash');
		expect(bound || explained || !venue.probe).toBe(true);
	});

	it.each(usable.map((v) => [v.id, v]))('%s prices its floor, not its ceiling', (_id, venue) => {
		const observed = venue.launch.valueObserved;
		if (!observed) return;
		expect(BigInt(venue.launch.value)).toBe(BigInt(observed.min));
		expect(BigInt(observed.max)).toBeGreaterThanOrEqual(BigInt(observed.min));
	});
});

describe('the live check', () => {
	const checked = usable.filter((v) => v.liveCheck);

	it('records a timestamp and a reason for anything that reverted', () => {
		for (const venue of checked) {
			expect(venue.liveCheck.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			if (!venue.liveCheck.ok) expect(venue.liveCheck.reason).toBeTruthy();
		}
	});

	it('is a filter you can select on', () => {
		expect(listVenues({ live: true }).every((v) => v.liveCheck?.ok)).toBe(true);
	});
});

describe('venues that were catalogued but cannot be driven', () => {
	it('each say why', () => {
		for (const venue of listVenues({ usable: false })) {
			expect(venue.reason, `${venue.id} is unusable without a reason`).toBeTruthy();
		}
	});
});

describe('lookup', () => {
	it('finds a venue by id and by address, ignoring case', () => {
		const venue = usable[0];
		expect(findVenue(venue.id)?.address).toBe(venue.address);
		expect(findVenue(venue.address.toUpperCase())?.id).toBe(venue.id);
	});

	it('returns null rather than guessing', () => {
		expect(findVenue('not-a-venue')).toBeNull();
		expect(findVenue('')).toBeNull();
	});

	it('requireVenue names the alternatives when it refuses', () => {
		expect(() => requireVenue('not-a-venue')).toThrow(/Launchable venues:/);
	});

	it('requireVenue refuses a venue that is catalogued but not launchable', () => {
		const broken = listVenues({ usable: false })[0];
		if (!broken) return;
		expect(() => requireVenue(broken.id)).toThrow(/not launchable/);
	});

	it('reports the kinds present', () => {
		expect(venueKinds().length).toBeGreaterThan(0);
		expect(venueKinds()).toEqual([...venueKinds()].sort());
	});
});
