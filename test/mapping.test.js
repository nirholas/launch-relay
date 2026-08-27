import { describe, expect, it } from 'vitest';
import { createMapper, render } from '../src/mapping.js';

const signal = (over = {}) => ({
	id: 'pumpfun:MINT9',
	source: 'pumpfun-graduations',
	kind: 'graduation',
	chain: 'solana',
	at: Date.now(),
	address: 'MINT9',
	name: 'Big Red Dog',
	symbol: 'BRD',
	description: 'a very good dog',
	imageUrl: 'https://example.com/dog.png',
	url: 'https://pump.fun/coin/MINT9',
	links: { twitter: 'https://x.com/dog', telegram: null, website: null },
	metrics: { marketCapUsd: 50_000 },
	...over,
});

describe('render', () => {
	it('substitutes known keys and empties unknown ones', () => {
		expect(render('{{a}}-{{b}}', { a: 'x' })).toBe('x-');
	});
});

describe('createMapper', () => {
	it('mirrors the source coin by default', async () => {
		const spec = await createMapper().map(signal());
		expect(spec.name).toBe('Big Red Dog');
		expect(spec.symbol).toBe('BRD');
		expect(spec.imageUrl).toBe('https://example.com/dog.png');
		expect(spec.links.twitter).toBe('https://x.com/dog');
	});

	it('always records provenance', async () => {
		const spec = await createMapper().map(signal());
		expect(spec.origin).toEqual({
			source: 'pumpfun-graduations',
			chain: 'solana',
			address: 'MINT9',
			url: 'https://pump.fun/coin/MINT9',
			signalId: 'pumpfun:MINT9',
		});
	});

	it('appends an attribution line naming the origin venue', async () => {
		const spec = await createMapper().map(signal());
		expect(spec.description).toContain('a very good dog');
		expect(spec.description).toContain('pump.fun');
		expect(spec.description).toContain('MINT9');
	});

	it('can drop attribution entirely', async () => {
		const spec = await createMapper({ attributionTemplate: null }).map(signal());
		expect(spec.description).toBe('a very good dog');
	});

	it('applies name and symbol templates', async () => {
		const spec = await createMapper({ nameTemplate: 'SOL {{name}}', symbolTemplate: 's{{symbol}}' }).map(signal());
		expect(spec.name).toBe('SOL Big Red Dog');
		expect(spec.symbol).toBe('SBRD');
	});

	it('respects the target ticker limit', async () => {
		const spec = await createMapper({ symbolMax: 4 }).map(signal({ symbol: 'ABCDEFGH' }));
		expect(spec.symbol).toBe('ABCD');
	});

	it('can refuse to carry links and artwork', async () => {
		const spec = await createMapper({ carryLinks: false, carryImage: false }).map(signal());
		expect(spec.imageUrl).toBeNull();
		expect(spec.links).toEqual({ twitter: null, telegram: null, website: null });
	});

	it('falls back to the source URL as the website', async () => {
		const spec = await createMapper().map(signal({ links: {} }));
		expect(spec.links.website).toBe('https://pump.fun/coin/MINT9');
	});

	it('throws rather than launching an unnamed coin', async () => {
		await expect(createMapper().map(signal({ name: '\u{1F680}', symbol: '\u{1F680}' })))
			.rejects.toThrow(/empty name/);
	});

	it('throws when no usable ticker can be derived', async () => {
		await expect(createMapper().map(signal({ name: 'A', symbol: '' }))).rejects.toThrow(/unusable symbol/);
	});

	it('runs the hints hook to produce target-specific intent', async () => {
		const mapper = createMapper({ hints: (spec) => ({ markets: [spec.symbol === 'BRD' ? 'TSLA' : 'SPY'] }) });
		const spec = await mapper.map(signal());
		expect(spec.targetHints).toEqual({ markets: ['TSLA'] });
	});
});
