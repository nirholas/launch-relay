// Name and ticker hygiene.
//
// Source names come from a permissionless launchpad, so they arrive with
// emoji, zero-width joiners, newlines, quotes that break JSON metadata, and
// tickers that collide with something already listed on the target. Every
// launch runs through here before a transaction is built, because a symbol is
// immutable once the token is deployed.

const SYMBOL_CHARS = /[^A-Z0-9]/g;
// Control and format characters: newlines, zero-width joiners, bidi overrides,
// and the BOM. They render as nothing but survive a JSON round trip and a
// block explorer, so a name that looks clean can still carry them.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export const SYMBOL_MAX = 10;
export const NAME_MAX = 32;

/**
 * Collapse a display name to something a launchpad and a chart legend can both
 * render. Keeps letters, digits, spaces, and light punctuation; drops
 * everything else rather than transliterating, so a fully emoji name returns
 * '' and the caller decides what to do about it.
 *
 * @param {string} raw
 * @param {number} [max]
 * @returns {string}
 */
export function sanitizeName(raw, max = NAME_MAX) {
	const cleaned = String(raw ?? '')
		.replace(INVISIBLE, ' ')
		.replace(/[^\p{L}\p{N} .,'!?&+-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length <= max) return cleaned;
	// Cut on a word boundary when one is close to the limit, else hard-cut.
	const cut = cleaned.slice(0, max);
	const space = cut.lastIndexOf(' ');
	return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

/**
 * Derive an uppercase A-Z0-9 ticker. Falls back to the name's initials, then
 * to its letters, so a coin whose symbol is pure emoji still gets a usable
 * ticker instead of an empty string.
 *
 * @param {string} rawSymbol
 * @param {string} [rawName]
 * @param {number} [max]
 * @returns {string}
 */
export function sanitizeSymbol(rawSymbol, rawName = '', max = SYMBOL_MAX) {
	const direct = String(rawSymbol ?? '')
		.replace(INVISIBLE, '')
		.toUpperCase()
		.replace(SYMBOL_CHARS, '');
	if (direct.length >= 2) return direct.slice(0, max);

	const nameWords = sanitizeName(rawName, 64).toUpperCase().split(/\s+/).filter(Boolean);
	const initials = nameWords.map((w) => w.replace(SYMBOL_CHARS, '').charAt(0)).join('');
	if (initials.length >= 3) return initials.slice(0, max);

	const letters = nameWords.join('').replace(SYMBOL_CHARS, '');
	if (letters.length >= 2) return letters.slice(0, max);

	return direct || letters || '';
}

/**
 * Find a free ticker on the target, starting from `base`. Appends a numeric
 * suffix and shrinks the stem so the result never exceeds `max`.
 *
 * `isTaken` is the target's own lookup. When it throws (the launchpad API is
 * down) the error propagates rather than launching a colliding ticker on a
 * guess: the caller decides whether an unverifiable symbol is acceptable.
 *
 * @param {string} base
 * @param {(symbol: string) => Promise<boolean>} isTaken
 * @param {{max?: number, attempts?: number}} [opts]
 * @returns {Promise<string|null>} A free symbol, or null when every candidate is taken.
 */
export async function uniqueSymbol(base, isTaken, { max = SYMBOL_MAX, attempts = 9 } = {}) {
	const stem = base.slice(0, max);
	if (!stem) return null;
	if (!(await isTaken(stem))) return stem;
	for (let n = 2; n <= attempts + 1; n++) {
		const suffix = String(n);
		const candidate = `${stem.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
		if (!(await isTaken(candidate))) return candidate;
	}
	return null;
}

/**
 * Trim a description to a length metadata hosts and card UIs accept, cutting
 * at a sentence or word boundary so the tail never reads as truncated garbage.
 *
 * @param {string} raw
 * @param {number} [max]
 * @returns {string}
 */
export function sanitizeDescription(raw, max = 480) {
	const cleaned = String(raw ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
	if (cleaned.length <= max) return cleaned;
	const cut = cleaned.slice(0, max);
	const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
	if (stop > max * 0.5) return cut.slice(0, stop + 1).trim();
	const space = cut.lastIndexOf(' ');
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}...`;
}
