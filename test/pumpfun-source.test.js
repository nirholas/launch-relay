import { describe, expect, it } from 'vitest';
import { normalizeGraduation } from '../src/sources/pumpfun-graduations.js';

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
