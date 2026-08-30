// Shared network helpers.
//
// Both launchpad targets mirror the source coin's artwork, and both have to do
// it against a URL a stranger controls. One implementation, so a guard added
// for one target protects the other.

export const USER_AGENT = 'launch-relay/0.1';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Fetch remote artwork with the guards a bot needs when the URL arrived inside
 * someone else's token metadata: http(s) only, no private network targets, a
 * byte cap enforced before and after the read, and an image content type.
 *
 * Returns null instead of throwing. A broken logo is a degraded launch, not a
 * failed one, and the caller decides which of those it is.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch, maxBytes?: number}} [opts]
 * @returns {Promise<{data: Uint8Array, contentType: string}|null>}
 */
/**
 * Public IPFS gateways, tried in order. A CID is content-addressed, so the same
 * bytes are served by any of them: a gateway that is rate-limiting or down is
 * an outage of that host, not of the artwork. Relaying a coin without its logo
 * because ipfs.io was busy is a worse outcome than one extra request.
 */
const IPFS_GATEWAYS = [
	'https://ipfs.io/ipfs/',
	'https://cloudflare-ipfs.com/ipfs/',
	'https://dweb.link/ipfs/',
	'https://gateway.pinata.cloud/ipfs/',
];

/**
 * Every URL worth trying for one piece of artwork, best first. For an IPFS URL
 * that is the same CID across each gateway; for anything else it is just the
 * URL itself.
 *
 * @param {URL} parsed
 * @returns {string[]}
 */
export function imageUrlCandidates(parsed) {
	const href = parsed.toString();
	const ipfsPath = parsed.pathname.match(/\/ipfs\/(.+)$/);
	if (!ipfsPath) return [href];
	const cid = ipfsPath[1];
	const alternates = IPFS_GATEWAYS.map((g) => g + cid).filter((u) => u !== href);
	return [href, ...alternates];
}

export async function fetchImageBytes(url, opts = {}) {
	const { timeoutMs = 15_000, fetchImpl = fetch, maxBytes = MAX_IMAGE_BYTES } = opts;
	let parsed;
	try {
		parsed = new URL(String(url));
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
	if (isPrivateHost(parsed.hostname)) return null;

	for (const candidate of imageUrlCandidates(parsed)) {
		const got = await fetchOneImage(candidate, { timeoutMs, fetchImpl, maxBytes });
		if (got) return got;
	}
	return null;
}

/**
 * One attempt at one URL. Returns null for every failure mode, so the caller
 * can move to the next candidate without distinguishing them.
 */
async function fetchOneImage(href, { timeoutMs, fetchImpl, maxBytes }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(href, {
			signal: controller.signal,
			redirect: 'follow',
			headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
		});
		if (!res.ok) return null;
		const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
		if (!contentType.startsWith('image/')) return null;
		if (Number(res.headers.get('content-length') || 0) > maxBytes) return null;
		const data = new Uint8Array(await res.arrayBuffer());
		if (data.byteLength === 0 || data.byteLength > maxBytes) return null;
		return { data, contentType };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Literal private-address check. It blocks the loopback and RFC1918 targets a
 * hostile metadata URL would use to probe the host running the relay. A public
 * name that resolves to a private address is the deployment's egress policy to
 * catch, not this function's.
 *
 * @param {string} hostname
 */
export function isPrivateHost(hostname) {
	const h = String(hostname || '').toLowerCase();
	if (!h) return true;
	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
	if (h === '::1' || h === '0.0.0.0' || h.startsWith('[::1')) return true;
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!v4) return false;
	const [a, b] = v4.slice(1).map(Number);
	if (a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

/**
 * JSON fetch with a timeout and a readable error. Every adapter needs this and
 * none of them need a client library for it.
 *
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, fetchImpl?: typeof fetch}} [init]
 */
export async function fetchJson(url, init = {}) {
	const { timeoutMs = 15_000, fetchImpl = fetch, ...rest } = init;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, {
			...rest,
			signal: controller.signal,
			headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(rest.headers || {}) },
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`${rest.method || 'GET'} ${url} -> ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
		}
		return res.status === 204 ? null : res.json();
	} catch (err) {
		if (err?.name === 'AbortError') throw new Error(`${url} timed out after ${timeoutMs}ms`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
