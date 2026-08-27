// pump.fun graduations on Solana.
//
// A coin "bonds" (graduates) when its bonding curve fills and liquidity
// migrates to an AMM. That moment is the trigger: it is the first instant a
// coin has provably cleared the bar, and it is public. Catching it late is the
// whole failure mode, so this source runs three independent rungs at once and
// deduplicates across them rather than picking one and hoping.
//
//   1. three.ws SSE      /api/pump/live-stream?kind=graduation
//                        Enriched events, pushed the moment the migration
//                        lands. Rotates its connection about every 55s by
//                        design, so a clean `end` event is normal.
//   2. PumpPortal WS     wss://pumpportal.fun/api/data, subscribeMigration
//                        The same upstream three.ws consumes, subscribed to
//                        directly so one operator's outage is not ours. Raw
//                        events, enriched here from pump.fun's coin endpoint.
//   3. HTTP backfill     /api/pump/recent-graduations on an interval
//                        The net. It catches anything both sockets dropped,
//                        including everything that happened while the process
//                        was restarting.
//
// Every rung emits the same normalized Signal, and a local seen-set collapses
// the duplicates that redundancy guarantees.

const THREEWS_BASE = 'https://three.ws';
const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';
const PUMPFUN_COIN_API = 'https://frontend-api-v3.pump.fun/coins';

const DEFAULT_POLL_MS = 20_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const SEEN_LIMIT = 5_000;
const ENRICH_TIMEOUT_MS = 6_000;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.stream]        Use the three.ws SSE rung. Default true.
 * @param {boolean} [opts.pumpPortal]    Use the PumpPortal WS rung. Default true.
 * @param {boolean} [opts.backfill]      Use the HTTP backfill rung. Default true.
 * @param {string} [opts.baseUrl]        three.ws origin.
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.backfillLimit]  Items per backfill poll. Default 25.
 * @param {boolean} [opts.emitBacklog]   Emit the first backfill page on start. Default false, so a
 *                                       restart does not replay yesterday's graduations.
 * @returns {import('../types.js').Source}
 */
export function createPumpFunGraduationSource(opts = {}) {
	const {
		stream = true, pumpPortal = true, backfill = true,
		baseUrl = THREEWS_BASE, pollIntervalMs = DEFAULT_POLL_MS,
		backfillLimit = 25, emitBacklog = false,
	} = opts;

	const seen = new Set();
	const firstSeen = (mint) => {
		const key = String(mint || '');
		if (!key || seen.has(key)) return false;
		seen.add(key);
		if (seen.size > SEEN_LIMIT) {
			const drop = Math.floor(SEEN_LIMIT / 4);
			const it = seen.keys();
			for (let i = 0; i < drop; i++) seen.delete(it.next().value);
		}
		return true;
	};

	return {
		id: 'pumpfun-graduations',
		chain: 'solana',

		/**
		 * @param {(s: import('../types.js').Signal) => void} onSignal
		 * @param {{signal: AbortSignal, log: import('../types.js').Logger}} ctx
		 */
		start(onSignal, { signal, log }) {
			const emit = async (raw, rung) => {
				const normalized = normalizeGraduation(raw);
				if (!normalized || !firstSeen(normalized.address)) return;
				const signalOut = await enrichSignal(normalized);
				log.debug(`${rung} -> ${signalOut.symbol || '?'} ${signalOut.address}`);
				onSignal(signalOut);
			};

			const stops = [];
			if (stream) stops.push(startSse(`${baseUrl}/api/pump/live-stream?kind=graduation`, emit, { signal, log }));
			if (pumpPortal) stops.push(startPumpPortal(emit, { signal, log }));
			if (backfill) {
				stops.push(startBackfill(
					`${baseUrl}/api/pump/recent-graduations?limit=${backfillLimit}`,
					emit,
					{ signal, log, intervalMs: pollIntervalMs, emitBacklog, seed: (mint) => firstSeen(mint) },
				));
			}
			if (!stops.length) throw new Error('pumpfun-graduations needs at least one rung enabled');

			return () => { for (const stop of stops) stop?.(); };
		},

		/** One-shot read, for `run --once` and for testing rules against real data. */
		async poll({ log } = { log: console }) {
			const page = await fetchJson(`${baseUrl}/api/pump/recent-graduations?limit=${backfillLimit}`);
			const items = page?.items || [];
			log?.debug?.(`backfill returned ${items.length} graduations`);
			const normalized = items.map(normalizeGraduation).filter(Boolean);
			return Promise.all(normalized.map(enrichSignal));
		},

		pollIntervalMs,
	};
}

// ── rung 1: three.ws SSE ─────────────────────────────────────────────────────

function startSse(url, emit, { signal, log }) {
	let stopped = false;
	let attempt = 0;

	(async function loop() {
		while (!stopped && !signal.aborted) {
			try {
				const res = await fetch(url, { signal, headers: { accept: 'text/event-stream' } });
				if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
				attempt = 0;
				log.debug('graduation stream connected');
				for await (const frame of readSse(res.body)) {
					if (frame.event === 'graduation' && frame.data) emit(frame.data, 'sse');
					// `end` is the server rotating the connection before its
					// request budget expires; reconnecting is the intended path.
					if (frame.event === 'end') break;
				}
			} catch (err) {
				if (stopped || signal.aborted) return;
				log.warn(`graduation stream dropped: ${err?.message || err}`);
			}
			if (stopped || signal.aborted) return;
			await sleep(backoff(attempt++), signal);
		}
	})();

	return () => { stopped = true; };
}

/**
 * Minimal SSE frame reader. The protocol is small enough that a parser is
 * fewer lines than a dependency, and it must not buffer the whole stream: this
 * connection stays open for the life of the relay.
 *
 * @param {ReadableStream<Uint8Array>} body
 */
async function* readSse(body) {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let split;
		while ((split = buffer.indexOf('\n\n')) !== -1) {
			const block = buffer.slice(0, split);
			buffer = buffer.slice(split + 2);
			let event = 'message';
			const dataLines = [];
			for (const line of block.split('\n')) {
				if (line.startsWith(':')) continue;
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
			}
			if (!dataLines.length) { yield { event, data: null }; continue; }
			try {
				yield { event, data: JSON.parse(dataLines.join('\n')) };
			} catch {
				yield { event, data: null };
			}
		}
	}
}

// ── rung 2: PumpPortal WebSocket ─────────────────────────────────────────────

function startPumpPortal(emit, { signal, log }) {
	if (typeof WebSocket !== 'function') {
		log.warn('PumpPortal rung skipped: this runtime has no global WebSocket (Node 22+ required)');
		return () => {};
	}
	let stopped = false;
	let attempt = 0;
	let socket = null;

	const connect = () => {
		if (stopped || signal.aborted) return;
		socket = new WebSocket(PUMPPORTAL_WS);

		socket.addEventListener('open', () => {
			attempt = 0;
			log.debug('pumpportal connected');
			socket.send(JSON.stringify({ method: 'subscribeMigration' }));
		});

		socket.addEventListener('message', async (event) => {
			let msg;
			try { msg = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text()); }
			catch { return; }
			if (msg?.txType !== 'migrate' && msg?.txType !== 'migration') return;
			// PumpPortal's migration message carries only the mint and pool. The
			// name, artwork, and market cap arrive during enrichment.
			emit({ ...msg, mint: msg.mint }, 'pumpportal');
		});

		socket.addEventListener('close', () => {
			if (stopped || signal.aborted) return;
			sleep(backoff(attempt++), signal).then(connect).catch(() => {});
		});

		socket.addEventListener('error', () => {
			// The close handler owns reconnection; this listener exists so an
			// error does not surface as an unhandled event.
			log.debug('pumpportal socket error');
		});
	};

	connect();
	signal.addEventListener('abort', () => { stopped = true; try { socket?.close(); } catch { /* already closed */ } });
	return () => { stopped = true; try { socket?.close(); } catch { /* already closed */ } };
}

// ── rung 3: HTTP backfill ────────────────────────────────────────────────────

function startBackfill(url, emit, { signal, log, intervalMs, emitBacklog, seed }) {
	let stopped = false;
	let primed = emitBacklog;

	(async function loop() {
		while (!stopped && !signal.aborted) {
			try {
				const page = await fetchJson(url, signal);
				for (const item of page?.items || []) {
					// The first page after start is history, not news. Seeding the
					// seen-set with it means a restart resumes instead of replaying.
					if (!primed) seed(item?.mint);
					else emit(item, 'backfill');
				}
				primed = true;
			} catch (err) {
				if (!signal.aborted) log.warn(`graduation backfill failed: ${err?.message || err}`);
			}
			await sleep(intervalMs, signal);
		}
	})();

	return () => { stopped = true; };
}

// ── normalization ────────────────────────────────────────────────────────────

/**
 * Map a graduation payload from any rung onto a Signal. Returns null when the
 * payload has no mint, which is the one field nothing downstream can work
 * without.
 *
 * @param {object} raw
 * @returns {import('../types.js').Signal|null}
 */
export function normalizeGraduation(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const mint = raw.mint || raw.address;
	if (!mint) return null;

	const graduatedAt = toMillis(raw.timestamp) ?? toMillis(raw._seen_at) ?? Date.now();
	const createdAt = toMillis(raw.created_at) ?? toMillis(raw.created_timestamp);
	const marketCapUsd = num(raw.usd_market_cap ?? raw.market_cap_usd);

	return {
		id: `pumpfun:${mint}`,
		source: 'pumpfun-graduations',
		kind: 'graduation',
		chain: 'solana',
		at: graduatedAt,
		address: mint,
		name: str(raw.name),
		symbol: str(raw.symbol),
		description: str(raw.description),
		imageUrl: str(raw.image_uri) || str(raw.image) || null,
		creator: str(raw.creator) || null,
		url: `https://pump.fun/coin/${mint}`,
		links: {
			twitter: str(raw.twitter) || null,
			telegram: str(raw.telegram) || null,
			website: str(raw.website) || null,
		},
		metrics: {
			marketCapUsd,
			athMarketCapUsd: num(raw.ath_market_cap),
			ageSeconds: createdAt ? Math.max(0, Math.round((graduatedAt - createdAt) / 1000)) : null,
			creatorLaunches: num(raw.creator_launches),
			replyCount: num(raw.reply_count),
		},
		raw,
	};
}

/**
 * Fill in whatever the rung did not carry.
 *
 * The rungs disagree about how much they know. PumpPortal sends a mint and
 * nothing else; the three.ws backfill sends a fully enriched row, except when
 * the migration is seconds old and its enrichment has not landed yet. Rules
 * read market cap and artwork, and a rule that rejects on a missing field
 * would silently filter out exactly the freshest graduations, which are the
 * ones worth relaying. So anything thin gets one lookup against pump.fun.
 *
 * @param {import('../types.js').Signal} signal
 * @returns {Promise<import('../types.js').Signal>}
 */
export async function enrichSignal(signal) {
	const thin = !signal.name || !signal.symbol || !signal.imageUrl || signal.metrics?.marketCapUsd == null;
	if (!thin) return signal;
	const coin = await fetchCoin(signal.address);
	if (!coin || !Object.keys(coin).length) return signal;
	const merged = normalizeGraduation({ ...signal.raw, ...coin, mint: signal.address });
	if (!merged) return signal;
	// The rung's own timestamp wins: it is when the graduation was observed,
	// while pump.fun's fields describe the coin, not the migration.
	return { ...merged, at: signal.at, id: signal.id, raw: { ...signal.raw, ...coin } };
}

async function fetchCoin(mint) {
	try {
		return (await fetchJson(`${PUMPFUN_COIN_API}/${encodeURIComponent(mint)}`, null, ENRICH_TIMEOUT_MS)) || {};
	} catch {
		// An unenriched graduation still carries its mint, and rules that need
		// the missing fields will reject it. That beats dropping the event.
		return {};
	}
}

async function fetchJson(url, signal = null, timeoutMs = 12_000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener('abort', onAbort);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { accept: 'application/json', 'user-agent': 'launch-relay/0.1' },
		});
		if (!res.ok) throw new Error(`${url} -> ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

// Upstream timestamps arrive in seconds, in milliseconds, and as ISO strings
// depending on the rung. Guessing wrong turns a fresh graduation into a
// 55-year-old one, which the age rule then silently rejects.
function toMillis(value) {
	if (value == null) return null;
	if (typeof value === 'string' && !/^\d+$/.test(value)) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return null;
	return n > 1e12 ? n : n * 1000;
}

const num = (v) => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const backoff = (attempt) => Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5));

function sleep(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}
