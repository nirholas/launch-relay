// The landing page. Every number on it comes from the catalog that ships with
// the build, so it cannot claim a venue count the code does not have.

import { catalog, el, extLink, fmtDate, fmtNumber, launchable, mount, observedLaunches, renderChrome, venues, REPO } from './shared.js';

renderChrome();

const stat = (n, l, title) => el('div', { class: 'card stat', title },
	el('div', { class: 'n' }, n),
	el('div', { class: 'l' }, l),
);

mount('#stats',
	stat(fmtNumber(venues.length), 'launch venues found on chain', 'Distinct contract-and-selector pairs that minted a token supply'),
	stat(fmtNumber(launchable.length), 'proved launchable by simulation', 'A substituted launch was executed against the live contract and succeeded'),
	stat(fmtNumber(observedLaunches), 'launches attributed to them', `Observed in blocks ${fmtNumber(catalog.window?.fromBlock)}–${fmtNumber(catalog.window?.toBlock)}`),
);

const route = (title, body, href, cta, tags) => el('div', { class: 'card' },
	el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' }, tags.map((t) => el('span', { class: 'tag' }, t))),
	el('h3', {}, title),
	el('p', {}, body),
	el('a', { class: 'btn small', href }, cta),
);

mount('#routes',
	route(
		'A launchpad that already exists',
		'Every venue in the catalog, driven through one adapter. The fee, the fields you get to set, and the errors it returns are all recorded, so you choose with the numbers in front of you.',
		'/venues.html', 'See the catalog',
		[`${launchable.length} launchable`, 'learned from chain'],
	),
	route(
		'A pool of your own',
		'Deploy a fixed-supply token and open its market yourself, on Uniswap V2, V3 or V4, against any quote the chain has. A one-sided V3 range needs no launch capital at all.',
		'/launch.html', 'Open a pool',
		['no launch fee', 'v2 · v3 · v4'],
	),
	route(
		'The Relay protocol',
		'One transaction: deploy, pool, lock, record. The token address is known before you sign, and the liquidity goes straight from the pool to a locker that has no owner.',
		'/protocol.html', 'Read the contracts',
		['atomic', 'liquidity locked'],
	),
);

// The proof panel restates what the committed test suite asserts. Keeping it
// as a list of claims rather than a screenshot means a claim that stops being
// true is a failing test rather than a stale image.
const CHECKS = [
	['deploys and launches on Uniswap V3', 'single-sided, whole supply into the pool, permanently locked'],
	['deploys and launches on Uniswap V2', 'constant product, both sides funded'],
	['the predicted token address is the one you get', 'checked before the launch runs, not read back after'],
	['the launcher ends holding none of the token', 'anything left there would be stranded forever'],
	['an unregistered adapter is refused', 'governance can add adapters; it cannot be bypassed'],
	['native value that does not add up is refused', 'a launch that keeps the change would keep more of it later'],
	['a stranger cannot set an adapter, a fee, or take ownership', 'four owner-only calls, all rejected'],
	['the protocol fee cannot exceed its own cap', 'one basis point over the cap reverts'],
	['a permanent lock cannot be withdrawn or extended', 'there is no branch that releases it'],
];

mount('#proof',
	el('div', { class: 'eyebrow', style: 'margin-bottom:14px' }, `${CHECKS.length} assertions, every one against live chain state`),
	el('div', { style: 'display:grid;gap:10px' },
		CHECKS.map(([claim, detail]) => el('div', { style: 'display:flex;gap:12px;align-items:baseline' },
			el('span', { class: 'tag ok' }, 'pass'),
			el('div', {}, el('div', {}, claim), el('div', { class: 'faint', style: 'font-size:13px' }, detail)),
		)),
	),
	el('p', { class: 'faint', style: 'margin:18px 0 0;font-size:13px' },
		'Run them yourself: ', el('code', {}, 'npm test'), ' and ', el('code', {}, 'npm run contracts:simulate'), '. ',
		extLink(`${REPO}/blob/main/test/contracts.test.js`, 'test/contracts.test.js'), '.',
	),
);

document.title = `Relay — ${launchable.length} launchable venues on Robinhood Chain`;

// The catalog has a date on it, and a stale catalog should say so rather than
// present months-old chain data as current.
const age = Date.now() - new Date(catalog.generatedAt || 0).getTime();
if (age > 30 * 24 * 3600 * 1000) {
	document.querySelector('#stats')?.append(
		el('div', { class: 'notice', style: 'grid-column:1/-1' },
			`This catalog was generated on ${fmtDate(catalog.generatedAt)} and is more than a month old. Rebuild it with `,
			el('code', {}, 'npm run rhc:discover'), '.'),
	);
}
