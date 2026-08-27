import { describe, expect, it } from 'vitest';
import { createRules } from '../src/rules.js';

const NOW = 1_700_000_000_000;

const signal = (over = {}) => ({
	id: 'pumpfun:MINT',
	source: 'pumpfun-graduations',
	kind: 'graduation',
	chain: 'solana',
	at: NOW - 10_000,
	name: 'Test Coin',
	symbol: 'TEST',
	description: 'a coin',
	imageUrl: 'https://example.com/a.png',
	links: {},
	metrics: { marketCapUsd: 50_000, athMarketCapUsd: 90_000, ageSeconds: 600, creatorLaunches: 1, replyCount: 12 },
	...over,
});

describe('createRules', () => {
	it('passes a signal that clears every configured bound', async () => {
		const rules = createRules({ minMarketCapUsd: 10_000 });
		const verdict = await rules.evaluate(signal(), NOW);
		expect(verdict.pass).toBe(true);
		expect(verdict.reasons).toEqual([]);
	});

	it('rejects a stale signal', async () => {
		const rules = createRules({ maxSignalAgeSeconds: 5 });
		const verdict = await rules.evaluate(signal(), NOW);
		expect(verdict.pass).toBe(false);
		expect(verdict.reasons[0]).toMatch(/signal age/);
	});

	it('fails closed when a thresholded metric is unknown', async () => {
		const rules = createRules({ minMarketCapUsd: 10_000 });
		const verdict = await rules.evaluate(signal({ metrics: { marketCapUsd: null } }), NOW);
		expect(verdict.pass).toBe(false);
		expect(verdict.reasons[0]).toMatch(/market cap unknown/);
	});

	it('does not apply a threshold that was never configured', async () => {
		const rules = createRules({});
		const verdict = await rules.evaluate(signal({ metrics: {} }), NOW);
		expect(verdict.pass).toBe(true);
	});

	it('rejects on a deny word anywhere in the text', async () => {
		const rules = createRules({ denyWords: ['rug'] });
		const verdict = await rules.evaluate(signal({ description: 'definitely not a RUG pull' }), NOW);
		expect(verdict.reasons[0]).toMatch(/deny word/);
	});

	it('requires an image by default', async () => {
		const rules = createRules({});
		const verdict = await rules.evaluate(signal({ imageUrl: null }), NOW);
		expect(verdict.reasons).toContain('no image');
	});

	it('enforces symbol allow and deny patterns', async () => {
		const allow = await createRules({ symbolAllow: ['^SOL'] }).evaluate(signal(), NOW);
		expect(allow.pass).toBe(false);
		const deny = await createRules({ symbolDeny: ['TEST'] }).evaluate(signal(), NOW);
		expect(deny.pass).toBe(false);
	});

	it('rejects a denied creator regardless of case', async () => {
		const rules = createRules({ creatorDeny: ['ABCdef'] });
		const verdict = await rules.evaluate(signal({ creator: 'abcDEF' }), NOW);
		expect(verdict.reasons[0]).toMatch(/denied/);
	});

	it('caps serial launchers', async () => {
		const rules = createRules({ maxCreatorLaunches: 2 });
		const verdict = await rules.evaluate(signal({ metrics: { ...signal().metrics, creatorLaunches: 9 } }), NOW);
		expect(verdict.reasons[0]).toMatch(/creator launches/);
	});

	it('collects every reason rather than stopping at the first', async () => {
		const rules = createRules({ minMarketCapUsd: 1e9, requireSocials: 'twitter' });
		const verdict = await rules.evaluate(signal(), NOW);
		expect(verdict.reasons).toHaveLength(2);
	});

	it('runs a custom predicate last', async () => {
		const rules = createRules({ custom: (s) => (s.symbol === 'TEST' ? 'blocked by custom rule' : null) });
		const verdict = await rules.evaluate(signal(), NOW);
		expect(verdict.reasons).toContain('blocked by custom rule');
	});
});
