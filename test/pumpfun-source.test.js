import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichSignal, normalizeGraduation } from '../src/sources/pumpfun-graduations.js';

describe('normalizeGraduation', () => {
	it('returns null without a mint', () => {
		expect(normalizeGraduation({ name: 'x' })).toBeNull();
		expect(normalizeGraduation(null)).toBeNull();
	});

	it('maps an enriched three.ws backfill row', () => {
		const signal = normalizeGraduation({
			mint: 'MINT1',
			name: 'Poppy',
			symbol: 'POPPY',
			description: 'a seagull',
			image_uri: 'https://ipfs.io/ipfs/x',
			creator: 'CREATOR1',
			twitter: 'https://x.com/p',
			timestamp: 1_787_836_184,
			created_at: 1_787_835_759,
			usd_market_cap: 151.23,
			ath_market_cap: 6_532.04,
			reply_count: 3,
		});
		expect(signal).toMatchObject({
			id: 'pumpfun:MINT1',
			kind: 'graduation',
			chain: 'solana',
			address: 'MINT1',
			symbol: 'POPPY',
			url: 'https://pump.fun/coin/MINT1',
		});
		expect(signal.at).toBe(1_787_836_184_000);
		expect(signal.metrics.ageSeconds).toBe(425);
		expect(signal.metrics.marketCapUsd).toBeCloseTo(151.23);
		expect(signal.links.twitter).toBe('https://x.com/p');
	});

	it('reads millisecond timestamps without shifting them by a factor of 1000', () => {
		const ms = normalizeGraduation({ mint: 'M', timestamp: 1_787_836_184_000 });
		const sec = normalizeGraduation({ mint: 'M', timestamp: 1_787_836_184 });
		expect(ms.at).toBe(sec.at);
	});

	it('parses an ISO timestamp', () => {
		const signal = normalizeGraduation({ mint: 'M', _seen_at: '2026-08-27T13:09:44.354Z' });
		expect(signal.at).toBe(Date.parse('2026-08-27T13:09:44.354Z'));
	});

	it('leaves unknown metrics null instead of guessing zero', () => {
		const signal = normalizeGraduation({ mint: 'M' });
		expect(signal.metrics).toEqual({
			marketCapUsd: null,
			athMarketCapUsd: null,
			ageSeconds: null,
			creatorLaunches: null,
			replyCount: null,
		});
	});

	it('accepts the pump.fun coin shape as well as the feed shape', () => {
		const signal = normalizeGraduation({
			mint: 'M', name: 'X', symbol: 'X', market_cap_usd: 1234, created_timestamp: 1_730_356_589_733,
		});
		expect(signal.metrics.marketCapUsd).toBe(1234);
		expect(signal.metrics.ageSeconds).toBeGreaterThan(0);
	});
});

describe('enrichSignal', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

	const thin = { id: 'pumpfun:MINT9', address: 'MINT9', at: 111, raw: { mint: 'MINT9' } };
	const json = (body) => ({ ok: true, status: 200, json: async () => body });

	it('re-reads a graduation pump.fun has not indexed yet', async () => {
		// The stream delivers the migration before the coin record exists, so the
		// first read is nameless. Dropping it there is the bug: the record lands
		// moments later.
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(url);
			return json(calls.length < 3 ? {} : { mint: 'MINT9', name: 'Gnocchicoin', symbol: 'GNOCCHI' });
		};
		const out = await enrichSignal(thin);
		expect(calls.length).toBe(3);
		expect(out).toMatchObject({ name: 'Gnocchicoin', symbol: 'GNOCCHI', address: 'MINT9' });
		// The rung's own observation time survives enrichment.
		expect(out.at).toBe(111);
		expect(out.id).toBe('pumpfun:MINT9');
	}, 30_000);

	it('gives up after the retries rather than stalling the feed', async () => {
		let calls = 0;
		globalThis.fetch = async () => { calls += 1; return json({}); };
		const out = await enrichSignal(thin);
		expect(calls).toBe(4);
		expect(out.name).toBeUndefined();
	}, 30_000);

	it('does not re-read when the first response already carries a name', async () => {
		let calls = 0;
		globalThis.fetch = async () => { calls += 1; return json({ mint: 'MINT9', name: 'Poppy', symbol: 'POPPY' }); };
		const out = await enrichSignal(thin);
		expect(calls).toBe(1);
		expect(out.name).toBe('Poppy');
	});
});
