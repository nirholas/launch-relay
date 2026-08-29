import { describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { createPairFundApi } from '../src/targets/pairfund/api.js';

const jsonResponse = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json', ...extraHeaders },
});

describe('createPairFundApi', () => {
	it('hashes exactly the metadata bytes it uploads', async () => {
		let sentBody = null;
		const fetchImpl = vi.fn(async (url, init) => {
			sentBody = init.body;
			return jsonResponse({ url: '/api/metadata/abc' });
		});
		const api = createPairFundApi({ fetchImpl });

		const { metadataURI, metadataHash } = await api.uploadMetadata({
			name: 'Poppy', symbol: 'POPPY', description: 'a seagull', image: 'https://pair.fund/api/images/x',
			twitter: 'https://x.com/p',
		});

		expect(metadataURI).toBe('https://pair.fund/api/metadata/abc');
		expect(metadataHash).toBe(keccak256(toBytes(sentBody)));
	});

	it('omits absent link fields so the hash matches the stored document', async () => {
		let sentBody = null;
		const api = createPairFundApi({
			fetchImpl: async (_url, init) => { sentBody = init.body; return jsonResponse({ url: '/api/metadata/x' }); },
		});
		await api.uploadMetadata({ name: 'A', symbol: 'A' });
		expect(JSON.parse(sentBody)).toEqual({ name: 'A', symbol: 'A', links: {} });
	});

	it('reports a symbol as taken only on an exact match', async () => {
		const api = createPairFundApi({
			fetchImpl: async () => jsonResponse({ items: [{ symbol: 'POPPYCAT' }, { symbol: 'poppy' }] }),
		});
		expect(await api.symbolTaken('POPPY')).toBe(true);
		expect(await api.symbolTaken('POPPYDOG')).toBe(false);
	});

	it('treats an empty symbol as unavailable', async () => {
		const api = createPairFundApi({ fetchImpl: async () => jsonResponse({ items: [] }) });
		expect(await api.symbolTaken('')).toBe(true);
	});

	it('raises a typed error carrying the upstream status', async () => {
		// 404 is the caller's fault and is never retried, so it surfaces at once.
		const api = createPairFundApi({ fetchImpl: async () => jsonResponse({ error: 'nope' }, 404) });
		await expect(api.stockTokens()).rejects.toMatchObject({ name: 'PairApiError', status: 404 });
	});

	it('retries a rate limit and succeeds once the server relents', async () => {
		let calls = 0;
		const api = createPairFundApi({
			fetchImpl: async () => {
				calls += 1;
				return calls === 1
					? jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' })
					: jsonResponse({ items: [] });
			},
		});
		await expect(api.stockTokens()).resolves.toEqual({ items: [] });
		expect(calls).toBe(2);
	});

	it('gives up on a rate limit that never clears', async () => {
		let calls = 0;
		const api = createPairFundApi({
			fetchImpl: async () => {
				calls += 1;
				return jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' });
			},
		});
		await expect(api.stockTokens()).rejects.toMatchObject({ name: 'PairApiError', status: 429 });
		expect(calls).toBe(4);
	});

	it('skips artwork that is too large rather than failing the launch', async () => {
		// A 413 from PAIR killed every launch carrying a big logo in the first
		// live run. Oversized art now degrades to no art.
		const oversized = new Uint8Array(1_200_000);
		const api = createPairFundApi({
			fetchImpl: async () =>
				new Response(oversized, { status: 200, headers: { 'content-type': 'image/png' } }),
		});
		expect(await api.mirrorImage('https://example.com/huge.png')).toBeNull();
	});

	it('returns null rather than throwing when artwork cannot be mirrored', async () => {
		const api = createPairFundApi({ fetchImpl: async () => new Response('nope', { status: 404 }) });
		expect(await api.mirrorImage('https://example.com/missing.png')).toBeNull();
	});

	it('refuses to mirror an image from a private address', async () => {
		const fetchImpl = vi.fn();
		const api = createPairFundApi({ fetchImpl });
		expect(await api.mirrorImage('http://127.0.0.1/secret.png')).toBeNull();
		expect(await api.mirrorImage('http://192.168.1.5/secret.png')).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('refuses a non-image response', async () => {
		const api = createPairFundApi({
			fetchImpl: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
		});
		expect(await api.mirrorImage('https://example.com/page.html')).toBeNull();
	});

	it('resolves a launch transaction into its token address', async () => {
		const api = createPairFundApi({
			fetchImpl: async () => jsonResponse({ status: 'registered', token: { address: '0xAbC0000000000000000000000000000000000001' } }),
		});
		expect(await api.registerLaunch('0xtx')).toBe('0xabc0000000000000000000000000000000000001');
	});

	it('rejects a registration that returns a malformed address', async () => {
		const api = createPairFundApi({
			fetchImpl: async () => jsonResponse({ status: 'registered', token: { address: 'not-an-address' } }),
		});
		await expect(api.registerLaunch('0xtx')).rejects.toThrow(/invalid token address/);
	});
});
