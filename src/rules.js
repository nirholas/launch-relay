// Signal filtering.
//
// The relay sees every graduation on pump.fun, which is far more coins than
// anyone wants to mirror. Rules are the cheap, deterministic layer that runs
// before any network call or wallet selection: they turn the firehose into the
// handful of coins worth spending gas on.
//
// Two properties matter. Every rejection carries a reason, so a dry run tells
// you which filter is starving the relay instead of leaving you guessing. And
// a rule whose input is missing fails CLOSED: a coin whose market cap could
// not be read is not "under the cap", it is unknown, and unknown does not pass
// a threshold that exists to bound risk.

/**
 * @typedef {object} RuleConfig
 * @property {string[]} [kinds]                Signal kinds to accept. Default ['graduation'].
 * @property {number} [minMarketCapUsd]
 * @property {number} [maxMarketCapUsd]
 * @property {number} [minAthMarketCapUsd]
 * @property {number} [maxSignalAgeSeconds]    Reject events already stale when we see them. Default 900.
 * @property {number} [maxAssetAgeSeconds]     Reject coins that took too long to bond.
 * @property {number} [minReplyCount]
 * @property {number} [maxCreatorLaunches]     Serial launchers are usually farms.
 * @property {boolean} [requireImage]          Default true.
 * @property {'none'|'any'|'twitter'} [requireSocials] Default 'none'.
 * @property {string[]} [denyWords]            Case-insensitive substrings checked across name, symbol, description.
 * @property {string[]} [symbolAllow]          Regex sources; symbol must match at least one.
 * @property {string[]} [symbolDeny]           Regex sources; symbol must match none.
 * @property {string[]} [creatorDeny]          Creator addresses to skip.
 * @property {(signal: import('./types.js').Signal) => (string|null|Promise<string|null>)} [custom]
 *           Extra predicate. Return a rejection reason string, or null to pass.
 */

export const DEFAULT_RULES = Object.freeze({
	kinds: ['graduation'],
	maxSignalAgeSeconds: 900,
	requireImage: true,
	requireSocials: 'none',
	denyWords: [],
	symbolAllow: [],
	symbolDeny: [],
	creatorDeny: [],
});

/**
 * Build a rule evaluator.
 *
 * @param {RuleConfig} [config]
 * @returns {{evaluate: (signal: import('./types.js').Signal, now?: number) => Promise<{pass: boolean, reasons: string[]}>, config: RuleConfig}}
 */
export function createRules(config = {}) {
	const cfg = { ...DEFAULT_RULES, ...config };
	const symbolAllow = cfg.symbolAllow.map((s) => new RegExp(s, 'i'));
	const symbolDeny = cfg.symbolDeny.map((s) => new RegExp(s, 'i'));
	const denyWords = cfg.denyWords.map((w) => String(w).toLowerCase()).filter(Boolean);
	const creatorDeny = new Set(cfg.creatorDeny.map((a) => String(a).toLowerCase()));

	async function evaluate(signal, now = Date.now()) {
		const reasons = [];
		const m = signal.metrics || {};

		if (cfg.kinds?.length && !cfg.kinds.includes(signal.kind)) {
			reasons.push(`kind ${signal.kind} not in [${cfg.kinds.join(', ')}]`);
		}

		if (cfg.maxSignalAgeSeconds != null) {
			const ageSec = (now - (signal.at || 0)) / 1000;
			if (!Number.isFinite(ageSec) || ageSec > cfg.maxSignalAgeSeconds) {
				reasons.push(`signal age ${Math.round(ageSec)}s > ${cfg.maxSignalAgeSeconds}s`);
			}
		}

		checkFloor(reasons, 'market cap', m.marketCapUsd, cfg.minMarketCapUsd, 'usd');
		checkCeiling(reasons, 'market cap', m.marketCapUsd, cfg.maxMarketCapUsd, 'usd');
		checkFloor(reasons, 'ath market cap', m.athMarketCapUsd, cfg.minAthMarketCapUsd, 'usd');
		checkFloor(reasons, 'replies', m.replyCount, cfg.minReplyCount, '');
		checkCeiling(reasons, 'asset age', m.ageSeconds, cfg.maxAssetAgeSeconds, 's');
		checkCeiling(reasons, 'creator launches', m.creatorLaunches, cfg.maxCreatorLaunches, '');

		if (cfg.requireImage && !signal.imageUrl) reasons.push('no image');

		if (cfg.requireSocials === 'twitter' && !signal.links?.twitter) {
			reasons.push('no twitter link');
		} else if (cfg.requireSocials === 'any') {
			const l = signal.links || {};
			if (!l.twitter && !l.telegram && !l.website) reasons.push('no social links');
		}

		const haystack = `${signal.name || ''} ${signal.symbol || ''} ${signal.description || ''}`.toLowerCase();
		const hit = denyWords.find((w) => haystack.includes(w));
		if (hit) reasons.push(`deny word "${hit}"`);

		const symbol = String(signal.symbol || '');
		if (symbolAllow.length && !symbolAllow.some((re) => re.test(symbol))) {
			reasons.push(`symbol "${symbol}" matches no allow pattern`);
		}
		const denied = symbolDeny.find((re) => re.test(symbol));
		if (denied) reasons.push(`symbol "${symbol}" matches deny ${denied}`);

		if (signal.creator && creatorDeny.has(String(signal.creator).toLowerCase())) {
			reasons.push(`creator ${signal.creator} denied`);
		}

		if (cfg.custom) {
			const custom = await cfg.custom(signal);
			if (custom) reasons.push(String(custom));
		}

		return { pass: reasons.length === 0, reasons };
	}

	return { evaluate, config: cfg };
}

// A threshold with an unreadable input rejects. `null` here means the upstream
// could not tell us, and a bound that silently stops applying is worse than no
// bound at all.
function checkFloor(reasons, label, value, min, unit) {
	if (min == null) return;
	if (value == null || !Number.isFinite(value)) {
		reasons.push(`${label} unknown, needs >= ${min}${unit}`);
		return;
	}
	if (value < min) reasons.push(`${label} ${round(value)}${unit} < ${min}${unit}`);
}

function checkCeiling(reasons, label, value, max, unit) {
	if (max == null) return;
	if (value == null || !Number.isFinite(value)) {
		reasons.push(`${label} unknown, needs <= ${max}${unit}`);
		return;
	}
	if (value > max) reasons.push(`${label} ${round(value)}${unit} > ${max}${unit}`);
}

const round = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);
