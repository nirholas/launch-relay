import { describe, expect, it } from 'vitest';
import { fetchImageBytes, imageUrlCandidates } from '../src/http.js';

const png = (body = 'x') => ({
	ok: true, status: 200,
	headers: new Headers({ 'content-type': 'image/png', 'content-length': String(body.length) }),
	arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});
const down = { ok: false, status: 503, headers: new Headers() };

describe('imageUrlCandidates', () => {
	it('expands an IPFS URL to every gateway, original first', () => {
		const c = imageUrlCandidates(new URL('https://ipfs.io/ipfs/QmABC'));
		expect(c[0]).toBe('https://ipfs.io/ipfs/QmABC');
		expect(c).toContain('https://cloudflare-ipfs.com/ipfs/QmABC');
		expect(new Set(c).size).toBe(c.length);
	});

	it('leaves a non-IPFS URL alone', () => {
		expect(imageUrlCandidates(new URL('https://gmgn.ai/x.png'))).toEqual(['https://gmgn.ai/x.png']);
	});
});

describe('fetchImageBytes', () => {
	it('falls through to the next gateway when the first is down', async () => {
		const calls = [];
		const fetchImpl = async (u) => { calls.push(u); return calls.length === 1 ? down : png('ok'); };
		const got = await fetchImageBytes('https://ipfs.io/ipfs/QmABC', { fetchImpl });
		expect(got?.contentType).toBe('image/png');
		expect(calls.length).toBe(2);
		expect(calls[1]).toMatch(/cloudflare-ipfs/);
	});

	it('returns null once every gateway has refused', async () => {
		let n = 0;
		const got = await fetchImageBytes('https://ipfs.io/ipfs/QmABC', { fetchImpl: async () => { n++; return down; } });
		expect(got).toBeNull();
		expect(n).toBe(4);
	});
});
