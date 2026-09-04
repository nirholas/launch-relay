// Putting a name to a discovered venue.
//
// Discovery finds contracts, not brands. A contract address and a launch count
// are enough to drive a launch but not enough for a human to choose between
// two of them, and inventing a name for an unverified contract would be the
// same mistake as inventing its ABI.
//
// So a label comes from evidence or it does not come at all:
//
//   curated       an identification this repository can point at a reason for,
//                 recorded beside the entry.
//   geckoterminal the DEX the venue's own launches ended up trading on. An
//                 aggregator that indexes a launchpad names it, and a token
//                 launched by contract X trading on DEX Y is a fact about X.
//   none          the venue keeps its address-derived id. Nameless is honest.

const GECKOTERMINAL = 'https://api.geckoterminal.com/api/v2/networks/robinhood';

/**
 * Identifications with a stated reason. Nothing goes in here on a hunch.
 *
 * @type {Record<string, {id: string, label: string, kind: string, url?: string, evidence: string}>}
 */
export const KNOWN_VENUES = Object.freeze({
	'0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62': {
		id: 'pair',
		label: 'PAIR V5',
		kind: 'stock-paired-pools',
		url: 'https://pair.fund',
		evidence: 'the launchpad proxy pair.fund\'s own frontend calls; driven by the hand-written adapter in src/targets/pairfund',
	},
	'0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007': {
		id: 'virtuals',
		label: 'Virtuals Protocol',
		kind: 'bonding-curve',
		url: 'https://app.virtuals.io',
		evidence: 'preLaunch(...uint8[] cores...) is the Virtuals bonding interface, and every token it launched carries an image on virtualprotocolcdn; Virtuals also appears as an indexed DEX on this chain',
	},
});

/**
 * @param {Array<object>} descriptors
 * @param {{fetchImpl?: typeof fetch|null, onProgress?: (msg: string) => void, delayMs?: number}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function labelVenues(descriptors, { fetchImpl = fetch, onProgress, delayMs = 2_500 } = {}) {
	const out = [];
	// Ids are how a caller names a venue on the command line, so two venues
	// sharing one is not cosmetic: it makes one of them unreachable. A DEX name
	// is not unique here (one project runs several launch contracts, and one
	// contract can expose several launch functions), so collisions are settled
	// rather than assumed away.
	const used = new Set();
	const unique = (id, descriptor) => {
		if (!used.has(id)) { used.add(id); return id; }
		const fn = descriptor.launch?.signature?.split('(')[0];
		for (const candidate of [fn && `${id}-${kebab(fn)}`, `${id}-${descriptor.address.slice(2, 8).toLowerCase()}`]) {
			if (candidate && !used.has(candidate)) { used.add(candidate); return candidate; }
		}
		let n = 2;
		while (used.has(`${id}-${n}`)) n++;
		used.add(`${id}-${n}`);
		return `${id}-${n}`;
	};

	for (const descriptor of descriptors) {
		const curated = KNOWN_VENUES[descriptor.address.toLowerCase()];
		if (curated) {
			out.push({ ...descriptor, id: unique(curated.id, descriptor), label: curated.label, kind: curated.kind, url: curated.url ?? null, labelSource: 'curated', labelEvidence: curated.evidence });
			continue;
		}
		if (descriptor.label) { out.push({ ...descriptor, id: unique(descriptor.id, descriptor), labelSource: descriptor.labelSource || 'curated' }); continue; }
		if (!fetchImpl || !descriptor.evidence?.token) { out.push({ ...descriptor, id: unique(descriptor.id, descriptor), labelSource: 'none' }); continue; }

		const dex = await lookupDex(descriptor.evidence.token, { fetchImpl }).catch(() => null);
		if (!dex) { out.push({ ...descriptor, id: unique(descriptor.id, descriptor), labelSource: 'none' }); continue; }
		onProgress?.(`${descriptor.address} launches trade on ${dex.name}`);
		out.push({
			...descriptor,
			id: unique(descriptor.id.startsWith('rhc-') ? dex.id : descriptor.id, descriptor),
			label: dex.name,
			labelSource: 'geckoterminal',
			labelEvidence: `${descriptor.evidence.symbol || descriptor.evidence.token} trades on ${dex.id}`,
		});
		await sleep(delayMs);
	}
	return out;
}

/**
 * Generic AMMs. A token trading on one of these says nothing about who
 * launched it: every launchpad on the chain eventually deposits into a
 * Uniswap-shaped pool, so naming a launchpad "Uniswap V2" because its
 * graduates trade there would be worse than leaving it nameless.
 */
const GENERIC_AMMS = /^(uniswap|pancakeswap|sushiswap|curve|ramses|giga|orvex|ekubo|synthra|rubicon|alandale|sectorone|parityswap|up-v\d|swaphood)/i;

/**
 * The venue a token's first pool was opened on, when an aggregator recognises
 * it as something other than a plain AMM.
 *
 * The *first* pool, not the deepest: a launchpad opens the pool a token starts
 * in, and whatever happens to liquidity afterwards is the market's doing.
 *
 * @param {string} token
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function lookupDex(token, { fetchImpl = fetch } = {}) {
	const response = await fetchImpl(`${GECKOTERMINAL}/tokens/${token}/pools`);
	if (!response.ok) return null;
	const body = await response.json();
	const pools = (body?.data || []).filter((pool) => pool.relationships?.dex?.data?.id);
	if (!pools.length) return null;
	const named = pools.filter((pool) => !GENERIC_AMMS.test(pool.relationships.dex.data.id));
	if (!named.length) return null;
	const oldest = named.reduce((best, pool) =>
		new Date(pool.attributes?.pool_created_at || 0) < new Date(best.attributes?.pool_created_at || 0) ? pool : best);
	const id = oldest.relationships.dex.data.id;
	return { id, name: prettify(id) };
}

/** `pons-v2-dex` reads as "Pons V2 Dex" once, and as noise every time after. */
function prettify(id) {
	return id
		.split('-')
		.map((part) => (/^v\d+$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(' ');
}

const kebab = (value) => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
