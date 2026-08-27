// PAIR's REST API.
//
// Public, unauthenticated, CORS-open, and rate-limited. It is not the
// launchpad: the launch itself is an on-chain call. What this API provides is
// everything around it, and two of those are load-bearing for a launch:
//
//   POST /api/images    mirrors the source coin's artwork onto PAIR's host
//   POST /api/metadata  stores the descriptor whose URI and keccak hash both
//                       go into the launch transaction
//
// The hash is why `uploadMetadata` serializes the descriptor exactly once and
// reuses that string for both the request body and the hash. Reserializing
// would risk a byte the second pass orders differently, and the on-chain
// commitment would then point at a document that does not match.

import { keccak256, toBytes } from 'viem';
import { fetchImageBytes } from '../../http.js';

export const PAIR_API_BASE = 'https://pair.fund';

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'launch-relay/0.1';

/**
 * @param {{baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [opts]
 */
export function createPairFundApi(opts = {}) {
	const baseUrl = (opts.baseUrl || PAIR_API_BASE).replace(/\/$/, '');
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const doFetch = opts.fetchImpl || fetch;

	async function request(path, init = {}) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await doFetch(`${baseUrl}${path}`, {
				...init,
				signal: controller.signal,
				headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(init.headers || {}) },
			});
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new PairApiError(`PAIR ${init.method || 'GET'} ${path} failed: ${res.status}`, res.status, body.slice(0, 400));
			}
			return res.status === 204 ? null : res.json();
		} catch (err) {
			if (err?.name === 'AbortError') throw new PairApiError(`PAIR ${path} timed out after ${timeoutMs}ms`, 0, '');
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	const postJson = (path, body) =>
		request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

	return {
		baseUrl,

		health: () => request('/api/healthz'),

		/** Every Robinhood Stock Token that can be a launch pair, newest state. */
		stockTokens: () => request('/api/stock-tokens'),

		/**
		 * @param {{page?: number, limit?: number, search?: string, sort?: string}} [query]
		 */
		tokens(query = {}) {
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(query)) if (v !== undefined) params.append(k, String(v));
			const qs = params.toString();
			return request(`/api/tokens${qs ? `?${qs}` : ''}`);
		},

		token: (address) => request(`/api/tokens/${String(address).toLowerCase()}`),

		platformStats: () => request('/api/stats/platform'),

		/**
		 * Is this ticker already listed? PAIR does not enforce uniqueness on
		 * chain, so this is a quality check, not a validity one: two tokens may
		 * share a symbol, and the second one is the one nobody finds.
		 *
		 * @param {string} symbol
		 * @returns {Promise<boolean>}
		 */
		async symbolTaken(symbol) {
			const wanted = String(symbol).trim().toUpperCase();
			if (!wanted) return true;
			const page = await this.tokens({ search: wanted, limit: 50 });
			const items = Array.isArray(page) ? page : page?.items || [];
			return items.some((t) => String(t?.symbol || '').toUpperCase() === wanted);
		},

		/**
		 * Mirror a remote image onto PAIR's host and return the permanent URL.
		 * Source artwork lives on IPFS gateways that go down; a launched token
		 * whose logo 404s six months later looks abandoned.
		 *
		 * @param {string} url
		 * @returns {Promise<string|null>} Absolute URL, or null when the source is unusable.
		 */
		async mirrorImage(url) {
			const bytes = await fetchImageBytes(url, { fetchImpl: doFetch, timeoutMs });
			if (!bytes) return null;
			const { url: stored } = await postJson('/api/images', {
				data: Buffer.from(bytes.data).toString('base64'),
				contentType: bytes.contentType,
			});
			return stored?.startsWith('http') ? stored : `${baseUrl}${stored}`;
		},

		/**
		 * Store the token descriptor and return what the launch call commits to.
		 *
		 * @param {{name: string, symbol: string, description?: string, image?: string, twitter?: string|null, telegram?: string|null, website?: string|null}} meta
		 * @returns {Promise<{metadataURI: string, metadataHash: `0x${string}`}>}
		 */
		async uploadMetadata(meta) {
			// Key order matches PAIR's own client so the stored document and the
			// hashed document are the same bytes.
			const descriptor = {
				name: meta.name,
				symbol: meta.symbol,
				description: meta.description,
				image: meta.image,
				links: {
					twitter: meta.twitter ?? undefined,
					telegram: meta.telegram ?? undefined,
					website: meta.website ?? undefined,
				},
			};
			const body = JSON.stringify(descriptor);
			const res = await request('/api/metadata', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			const uri = res?.url?.startsWith('http') ? res.url : `${baseUrl}${res?.url}`;
			if (!res?.url) throw new PairApiError('PAIR metadata upload returned no url', 0, JSON.stringify(res));
			return { metadataURI: uri, metadataHash: keccak256(toBytes(body)) };
		},

		/**
		 * Ask PAIR's indexer to resolve a launch transaction into its token
		 * address. This is also what makes the token appear in the explorer, so
		 * it runs even when the address is already known from simulation.
		 *
		 * @param {string} txHash
		 * @param {{timeoutMs?: number, intervalMs?: number}} [wait]
		 * @returns {Promise<string|null>} Lowercased token address, or null on timeout.
		 */
		async registerLaunch(txHash, { timeoutMs: waitMs = 30_000, intervalMs = 2_000 } = {}) {
			const deadline = Date.now() + waitMs;
			for (;;) {
				let res;
				try {
					res = await postJson('/api/launches/register', { txHash });
				} catch {
					return null;
				}
				if (res?.status === 'registered') {
					const address = res?.token?.address;
					if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
						throw new PairApiError('PAIR registration returned an invalid token address', 0, JSON.stringify(res));
					}
					return address.toLowerCase();
				}
				if (Date.now() >= deadline) return null;
				await sleep(intervalMs);
			}
		},

		/** Poll until the token page exists, so a caller can link to a live page. */
		async waitForIndex(address, { timeoutMs: waitMs = 120_000, intervalMs = 2_000 } = {}) {
			const deadline = Date.now() + waitMs;
			while (Date.now() < deadline) {
				try {
					await request(`/api/tokens/${String(address).toLowerCase()}`);
					return true;
				} catch { /* not indexed yet */ }
				await sleep(intervalMs);
			}
			return false;
		},
	};
}

export class PairApiError extends Error {
	constructor(message, status, body) {
		super(message);
		this.name = 'PairApiError';
		this.status = status;
		this.body = body;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
