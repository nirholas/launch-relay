// Signal to LaunchSpec.
//
// This is the editorial layer: it decides what the relayed coin is called,
// what its description says, and what it credits. Templates rather than hard
// strings, because the same relay runs for a themed campaign ("SOL <name>")
// and for a straight mirror, and neither should need a code change.
//
// Provenance is not optional. Every spec carries `origin`, and the default
// description template states where the coin came from, so a relayed token is
// never presented as an original launch.

import { sanitizeDescription, sanitizeName, sanitizeSymbol } from './symbols.js';

export const DEFAULT_TEMPLATES = Object.freeze({
	name: '{{name}}',
	symbol: '{{symbol}}',
	description: '{{description}}',
	attribution: 'Relayed by launch-relay after {{symbol}} bonded on {{sourceChain}} {{sourceVenue}}. Origin: {{address}}',
});

/**
 * @typedef {object} MapperConfig
 * @property {string} [nameTemplate]
 * @property {string} [symbolTemplate]
 * @property {string} [descriptionTemplate]
 * @property {string|null} [attributionTemplate] Appended to the description. Null omits it.
 * @property {number} [symbolMax]                Target ticker limit. Default 10.
 * @property {number} [nameMax]                  Target name limit. Default 32.
 * @property {boolean} [carryLinks]              Copy the source coin's socials. Default true.
 * @property {boolean} [carryImage]              Mirror the source image. Default true.
 * @property {(spec: import('./types.js').LaunchSpec, signal: import('./types.js').Signal) => (object|Promise<object>)} [hints]
 *           Produce venue-specific `targetHints` (which stock markets to pair, dev buy size).
 */

/**
 * @param {MapperConfig} [config]
 */
export function createMapper(config = {}) {
	const cfg = {
		nameTemplate: DEFAULT_TEMPLATES.name,
		symbolTemplate: DEFAULT_TEMPLATES.symbol,
		descriptionTemplate: DEFAULT_TEMPLATES.description,
		attributionTemplate: DEFAULT_TEMPLATES.attribution,
		symbolMax: 10,
		nameMax: 32,
		carryLinks: true,
		carryImage: true,
		...config,
	};

	/**
	 * @param {import('./types.js').Signal} signal
	 * @returns {Promise<import('./types.js').LaunchSpec>}
	 */
	async function map(signal) {
		const vars = templateVars(signal);
		const name = sanitizeName(render(cfg.nameTemplate, vars), cfg.nameMax);
		const symbol = sanitizeSymbol(render(cfg.symbolTemplate, vars), name, cfg.symbolMax);

		if (!name) throw new Error(`signal ${signal.id} produced an empty name`);
		if (symbol.length < 2) throw new Error(`signal ${signal.id} produced an unusable symbol "${symbol}"`);

		const body = render(cfg.descriptionTemplate, vars).trim();
		const attribution = cfg.attributionTemplate ? render(cfg.attributionTemplate, vars).trim() : '';
		const description = sanitizeDescription([body, attribution].filter(Boolean).join('\n\n'));

		/** @type {import('./types.js').LaunchSpec} */
		const spec = {
			name,
			symbol,
			description,
			imageUrl: cfg.carryImage ? signal.imageUrl || null : null,
			links: cfg.carryLinks
				? {
					twitter: signal.links?.twitter || null,
					telegram: signal.links?.telegram || null,
					website: signal.links?.website || signal.url || null,
				}
				: { twitter: null, telegram: null, website: null },
			origin: {
				source: signal.source,
				chain: signal.chain,
				address: signal.address || null,
				url: signal.url || null,
				signalId: signal.id,
			},
			targetHints: {},
		};

		if (cfg.hints) spec.targetHints = (await cfg.hints(spec, signal)) || {};
		return spec;
	}

	return { map, config: cfg };
}

function templateVars(signal) {
	return {
		name: signal.name || '',
		symbol: signal.symbol || '',
		description: signal.description || '',
		address: signal.address || '',
		creator: signal.creator || '',
		source: signal.source || '',
		sourceChain: signal.chain || '',
		sourceVenue: venueOf(signal),
		url: signal.url || '',
		marketCapUsd: signal.metrics?.marketCapUsd == null ? '' : Math.round(signal.metrics.marketCapUsd),
	};
}

// The human name of where a signal came from, derived from the source id
// ('pumpfun-graduations' reads as 'pump.fun') so attribution text stays right
// when a new source is added.
function venueOf(signal) {
	const id = String(signal.source || '');
	if (id.startsWith('pumpfun')) return 'pump.fun';
	if (id.startsWith('pairfund')) return 'PAIR';
	if (id === 'manual') return 'manual input';
	return id || 'an upstream venue';
}

/**
 * Substitute `{{key}}` placeholders. Unknown keys collapse to '' rather than
 * rendering literally, so a typo in a template yields a short string instead of
 * a token named "SOL {{nmae}}".
 *
 * @param {string} template
 * @param {Record<string, string|number>} vars
 */
export function render(template, vars) {
	return String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
		const v = vars[key];
		return v == null ? '' : String(v);
	});
}
