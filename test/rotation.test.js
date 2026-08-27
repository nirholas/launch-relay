import { describe, expect, it } from 'vitest';
import { pickWallet } from '../src/wallets/rotation.js';

const wallets = ['0xaaa', '0xbbb', '0xccc'].map((address) => ({ address }));

describe('pickWallet', () => {
	it('returns null for an empty candidate list', () => {
		expect(pickWallet([], { strategy: 'round-robin' }).wallet).toBeNull();
	});

	it('round-robin advances the cursor across calls', () => {
		let cursor = 0;
		const seen = [];
		for (let i = 0; i < 4; i++) {
			const out = pickWallet(wallets, { strategy: 'round-robin', cursor });
			cursor = out.cursor;
			seen.push(out.wallet.address);
		}
		expect(seen).toEqual(['0xaaa', '0xbbb', '0xccc', '0xaaa']);
	});

	it('least-recently-used picks the coldest wallet', () => {
		const usage = new Map([
			['0xaaa', { lastUsedAt: 500, launches: 1 }],
			['0xbbb', { lastUsedAt: 100, launches: 1 }],
			['0xccc', { lastUsedAt: 900, launches: 1 }],
		]);
		expect(pickWallet(wallets, { strategy: 'least-recently-used', usage }).wallet.address).toBe('0xbbb');
	});

	it('least-used breaks ties on staleness so an idle pool still rotates', () => {
		const usage = new Map([
			['0xaaa', { lastUsedAt: 900, launches: 2 }],
			['0xbbb', { lastUsedAt: 100, launches: 2 }],
			['0xccc', { lastUsedAt: 500, launches: 5 }],
		]);
		expect(pickWallet(wallets, { strategy: 'least-used', usage }).wallet.address).toBe('0xbbb');
	});

	it('richest picks the largest balance', () => {
		const balances = new Map([['0xaaa', 1n], ['0xbbb', 99n], ['0xccc', 5n]]);
		expect(pickWallet(wallets, { strategy: 'richest', balances }).wallet.address).toBe('0xbbb');
	});

	it('random uses the injected generator', () => {
		expect(pickWallet(wallets, { strategy: 'random', random: () => 0.9 }).wallet.address).toBe('0xccc');
	});

	it('sticky keeps returning the first candidate', () => {
		expect(pickWallet(wallets, { strategy: 'sticky' }).wallet.address).toBe('0xaaa');
		expect(pickWallet(wallets, { strategy: 'sticky' }).wallet.address).toBe('0xaaa');
	});

	it('falls back to round-robin for an unknown strategy', () => {
		expect(pickWallet(wallets, { strategy: 'nonsense', cursor: 1 }).wallet.address).toBe('0xbbb');
	});
});
