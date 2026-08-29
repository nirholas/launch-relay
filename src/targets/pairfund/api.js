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

// PAIR's API is public, unauthenticated and shared. A relay that reacts to a
// burst of graduations can fire dozens of uploads in a second, get itself
// rate-limited, and fail every launch in the burst. Requests are therefore
// serialized behind a minimum interval, and a 429 is waited out rather than
// retried into the ground.
const MIN_REQUEST_INTERVAL_MS = 350;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/** Largest image we will POST. Base64 inflates it by about 4/3, so this keeps
 * the JSON body near 1.4MB; larger artwork came back 413 in the live run. */
export const MAX_IMAGE_BYTES = 1_000_000;

let requestChain = Promise.resolve();

/** Serialize every call and space them out, so a burst becomes a queue. */
function throttle(fn) {
	const run = requestChain.then(async () => {
		const started = Date.now();
		try {
			return await fn();
		} finally {
			const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - started);
			if (wait > 0) await sleep(wait);
		}
	});
	// The chain itself must never reject, or one failure poisons every request
	// queued behind it.
	requestChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** Milliseconds from a Retry-After header, which is a delay or an HTTP date. */
function retryAfterMs(header) {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const at = Date.parse(header);
	return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * @param {{baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [opts]
 */
export function createPairFundApi(opts = {}) {
	const baseUrl = (opts.baseUrl || PAIR_API_BASE).replace(/\/$/, '');
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const doFetch = opts.fetchImpl || fetch;

	async function attempt(path, init) {
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
				throw new PairApiError(
					`PAIR ${init.method || 'GET'} ${path} failed: ${res.status}`,
					res.status,
					body.slice(0, 400),
					retryAfterMs(res.headers.get('retry-after')),
				);
			}
			return res.status === 204 ? null : res.json();
		} catch (err) {
			if (err?.name === 'AbortError') throw new PairApiError(`PAIR ${path} timed out after ${timeoutMs}ms`, 0, '');
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Throttled, and retried on the statuses that mean "later, not never".
	 * A 4xx that is not 429 is the caller's fault and fails immediately.
	 */
	async function request(path, init = {}) {
		let lastError;
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			try {
				return await throttle(() => attempt(path, init));
			} catch (err) {
				lastError = err;
				const status = err instanceof PairApiError ? err.status : 0;
				if (!RETRY_STATUSES.has(status) || i === MAX_ATTEMPTS - 1) throw err;
				// Honour Retry-After when the server sent one, otherwise back
				// off exponentially: 1s, 2s, 4s.
				const backoff = err.retryAfterMs ?? 1000 * 2 ** i;
				await sleep(Math.min(backoff, 30_000));
			}
		}
		throw lastError;
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

		trending: () => request('/api/stats/trending'),

		/** Fee balances a wallet can claim right now, across every locker. */
		feesClaimable: (wallet) => request(`/api/fees/claimable/${String(wallet).toLowerCase()}`),

		/** Fees still inside the LP positions, not yet swept by the keeper. */
		feesPending: (wallet) => request(`/api/fees/pending/${String(wallet).toLowerCase()}`),

		/** Past claim transactions for a wallet. */
		feesHistory: (wallet) => request(`/api/fees/history/${String(wallet).toLowerCase()}`),

		/** Tokens a wallet has launched, newest first. */
		walletTokens: (wallet) => request(`/api/profiles/${String(wallet).toLowerCase()}/tokens`),

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
			// Oversized source artwork is a property of the source coin, not a
			// fault the relay can fix without an image encoder. Returning null
			// launches the token without a logo, which beats failing the launch
			// outright on a guaranteed 413.
			if (bytes.data.length > MAX_IMAGE_BYTES) return null;
			try {
				return await this.uploadImage(bytes.data, bytes.contentType);
			} catch (err) {
				// A 4xx means PAIR will never accept this particular image, so
				// retrying it re-uploads a doomed payload on every attempt. The
				// launch proceeds without artwork instead. A 5xx or a timeout is
				// a different story and still propagates, because that one is
				// worth retrying.
				const status = err instanceof PairApiError ? err.status : 0;
				if (status >= 400 && status < 500) return null;
				throw err;
			}
		},

		/**
		 * Store raw image bytes and return the permanent URL. The primitive
		 * behind `mirrorImage`, exposed because artwork does not always start
		 * life at a URL: a locally generated or locally stored logo needs the
		 * same hosted home as a mirrored one.
		 *
		 * @param {Uint8Array|Buffer} data
		 * @param {string} contentType
		 * @returns {Promise<string>} Absolute URL on PAIR's image host.
		 */
		async uploadImage(data, contentType) {
			if (!contentType?.startsWith('image/')) {
				throw new PairApiError(`contentType must be an image type, got "${contentType}"`, 0, '');
			}
			if (data.length > MAX_IMAGE_BYTES) {
				throw new PairApiError(
					`image is ${(data.length / 1024).toFixed(0)}KB, over the ${MAX_IMAGE_BYTES / 1024}KB limit`,
					413,
					'',
				);
			}
			const { url: stored } = await postJson('/api/images', {
				data: Buffer.from(data).toString('base64'),
				contentType,
			});
			if (!stored) throw new PairApiError('PAIR image upload returned no url', 0, '');
			return stored.startsWith('http') ? stored : `${baseUrl}${stored}`;
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
	constructor(message, status, body, retryAfter = null) {
		super(message);
		this.name = 'PairApiError';
		this.status = status;
		this.body = body;
		/** Server-requested wait before a retry, in ms, when it sent one. */
		this.retryAfterMs = retryAfter;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
