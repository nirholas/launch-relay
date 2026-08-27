import { describe, expect, it } from 'vitest';
import { sanitizeDescription, sanitizeName, sanitizeSymbol, uniqueSymbol } from '../src/symbols.js';

describe('sanitizeSymbol', () => {
	it('strips decoration and uppercases', () => {
		expect(sanitizeSymbol('$poppy!!')).toBe('POPPY');
	});

	it('falls back to initials when the symbol is unusable', () => {
		expect(sanitizeSymbol('', 'Big Red Dog')).toBe('BRD');
	});

	it('falls back to letters when there are too few words for initials', () => {
		expect(sanitizeSymbol('', 'Cheesecake')).toBe('CHEESECAKE');
	});

	it('drops zero-width characters that survive a JSON round trip', () => {
		expect(sanitizeSymbol('PU​MP')).toBe('PUMP');
	});

	it('honours the target ticker limit', () => {
		expect(sanitizeSymbol('ABCDEFGHIJKLMNOP', '', 6)).toBe('ABCDEF');
	});
});

describe('sanitizeName', () => {
	it('collapses emoji and whitespace', () => {
		expect(sanitizeName('  Poppy \u{1F680}  the   Sailor  ')).toBe('Poppy the Sailor');
	});

	it('cuts on a word boundary near the limit', () => {
		expect(sanitizeName('Poppy The Seagull Sailor Adventure', 20)).toBe('Poppy The Seagull');
	});

	it('returns empty for a name with nothing renderable', () => {
		expect(sanitizeName('\u{1F680}\u{1F680}')).toBe('');
	});
});

describe('sanitizeDescription', () => {
	it('keeps short text untouched', () => {
		expect(sanitizeDescription('a small coin')).toBe('a small coin');
	});

	it('cuts at a sentence boundary when one is available', () => {
		const text = `${'x'.repeat(40)}. ${'y'.repeat(80)}`;
		expect(sanitizeDescription(text, 60)).toBe(`${'x'.repeat(40)}.`);
	});

	it('turns newlines into spaces rather than deleting them', () => {
		expect(sanitizeDescription('line one\nline two')).toBe('line one line two');
	});
});

describe('uniqueSymbol', () => {
	it('returns the base when it is free', async () => {
		expect(await uniqueSymbol('POPPY', async () => false)).toBe('POPPY');
	});

	it('suffixes until it finds a free variant', async () => {
		const taken = new Set(['POPPY', 'POPPY2']);
		expect(await uniqueSymbol('POPPY', async (s) => taken.has(s))).toBe('POPPY3');
	});

	it('shrinks the stem so the suffix fits the limit', async () => {
		const taken = new Set(['ABCDEF']);
		expect(await uniqueSymbol('ABCDEF', async (s) => taken.has(s), { max: 6 })).toBe('ABCDE2');
	});

	it('returns null when every variant is taken', async () => {
		expect(await uniqueSymbol('X', async () => true, { attempts: 3 })).toBeNull();
	});

	it('propagates a lookup failure instead of guessing', async () => {
		await expect(uniqueSymbol('X', async () => { throw new Error('api down'); })).rejects.toThrow('api down');
	});
});
