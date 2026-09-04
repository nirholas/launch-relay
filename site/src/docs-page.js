// The documentation, as data.
//
// Written here rather than as static markup so the table of contents cannot
// drift from the sections, and so the counts and command names in the prose
// come from the same catalog and package the code uses.

import { catalog, el, extLink, fmtNumber, launchable, mount, renderChrome, REPO, venues } from './shared.js';

renderChrome();

const code = (text) => el('pre', {}, el('code', {}, text));
const p = (...children) => el('p', {}, ...children);
const li = (...children) => el('li', {}, ...children);
const ul = (...items) => el('ul', { style: 'margin:0 0 1em;padding-left:20px;color:var(--text-dim);display:grid;gap:6px' }, ...items);
const src = (path, label) => extLink(`${REPO}/blob/main/${path}`, label || path);

const SECTIONS = [
	{
		id: 'quickstart',
		title: 'Quick start',
		body: () => [
			p('Four commands, in this order. None of them can spend anything.'),
			code(`npx launch-relay venues            # every launchpad found on chain
npx launch-relay venue pair       # one of them in full
npx launch-relay pools            # pool shapes you can open yourself
npx launch-relay launch --venue pons-v2-launch-token \\
  --name "Loop Rat" --symbol LOOPRAT`),
			p('The last one builds and prices a launch and stops. Sending it needs two keys turned at once:'),
			code(`export LAUNCH_RELAY_ARMED=1                 # deliberate, out of band
export LAUNCH_RELAY_EVM_KEYS=0x...          # or LAUNCH_RELAY_MNEMONIC

npx launch-relay launch --live --venue pons-v2-launch-token \\
  --name "Loop Rat" --symbol LOOPRAT --image https://example.com/rat.png`),
			p('Without ', el('code', {}, 'LAUNCH_RELAY_ARMED=1'), ' the ', el('code', {}, '--live'),
				' flag refuses, so no config file and no stray flag can enable spending on its own.'),
		],
	},
	{
		id: 'venues',
		title: 'Launching on a catalogued venue',
		body: () => [
			p(`Robinhood Chain has ${fmtNumber(venues.length)} contracts that have launched a token. `,
				`${fmtNumber(launchable.length)} of them were driven through a full simulated launch and worked; `,
				'the rest are in the catalog too, each with the reason it was refused.'),
			code(`import { createRobinhoodVenueTarget, findVenue } from 'launch-relay';

const target = createRobinhoodVenueTarget({ venue: 'virtuals' });
const plan = await target.plan(spec, { wallet, log });
console.log(plan.summary.join('\\n'));
const result = await target.execute(plan, { wallet, log });`),
			p('A venue descriptor says which fields a launch may set. Everything else replays a transaction that already launched a token on that contract, so nothing is invented, defaulted, or zeroed:'),
			code(`findVenue('virtuals').launch.bindings.map((b) => b.role)
// ['name', 'symbol', 'imageUrl', 'buyAmount']`),
			p('An opening buy always defaults to zero. Inheriting one from whoever launched first is not a default, it is an accident.'),
		],
	},
	{
		id: 'pools',
		title: 'Opening a pool of your own',
		body: () => [
			p('No launchpad, no launch fee, and no contract in the middle that can change what it does next week. Deploy a fixed-supply token and open its market on the terms you choose.'),
			code(`import { createPoolLaunchTarget } from 'launch-relay';

const target = createPoolLaunchTarget({
  amm: 'uniswap-v3',
  quote: 'WETH',
  poolType: 'single-sided',
  fee: 10_000,          // 1%
  startFdv: 2,          // the whole supply opens valued at 2 WETH
  rangeMultiple: 1000,  // offered for sale up to 1000x the start
});`),
			p(el('strong', {}, 'A one-sided range is the one worth understanding.'),
				' A concentrated position whose range sits entirely above the current price holds only the launch token: the whole supply is offered for sale from the starting valuation upward, and the pool fills with quote as people buy. No launch capital, no matching deposit, and no way for you to sell into your own pool from the other side.'),
			ul(
				li(el('code', {}, 'uniswap-v2'), ' — constant product, both sides funded, 0.30%.'),
				li(el('code', {}, 'uniswap-v3'), ' — full range or one-sided, four fee tiers, any ERC-20 quote.'),
				li(el('code', {}, 'uniswap-v4'), ' — the same, inside a singleton, with a hook address in the pool key.'),
			),
			p('V2 and V3 forks on this chain implement the same interfaces, so passing ', el('code', {}, 'factory'), ' launches on the fork.'),
		],
	},
	{
		id: 'catalog',
		title: 'How the catalog is built',
		body: () => [
			p('Nothing in it was typed out. Discovery scans the chain for transfers from the zero address, takes the transaction that produced each one, and groups by the contract it called. Venues rank themselves by how many coins they really launched.'),
			code(`npm run rhc:discover -- --blocks 200000    # rescan, relearn, re-probe
npm run rhc:discover -- --no-simulate      # skip the probe, at the cost of proof
npm run rhc:verify                         # re-derive every pinned address`),
			p('Two checks make the result trustworthy, and they answer different questions:'),
			ul(
				li(el('strong', {}, 'Re-encoding. '), 'A descriptor must reproduce its anchor transaction\'s calldata byte for byte. That proves the ABI was read correctly, and the test suite asserts it for every venue that ships.'),
				li(el('strong', {}, 'Substitution. '), 'Every field is then replaced and re-simulated against the live contract, one at a time. That proves the field is yours to set, which re-encoding says nothing about.'),
			),
			p('The second check earns its keep immediately. One venue\'s launch call carries two ',
				el('code', {}, 'bytes32'), ' arguments and both look like salts. The first is a commitment to a launch configuration the venue publishes; changing it reverts. The second is the real salt. Nothing in the ABI distinguishes them; one ', el('code', {}, 'eth_call'), ' each does.'),
			p('Adding a venue is usually one line in ', src('src/chains/robinhood/venues/seeds.json', 'seeds.json'),
				'. The full procedure is in ', src('docs/robinhood-chain.md'), '.'),
		],
	},
	{
		id: 'relay',
		title: 'Relaying automatically',
		body: () => [
			p('The original job: watch one venue, launch on another, from a pool of wallets, with a budget and an approval step.'),
			code(`import { presets } from 'launch-relay';

const { relay } = await presets.pumpfunToRobinhoodVenue({
  venue: 'virtuals',
  mnemonic: process.env.LAUNCH_RELAY_MNEMONIC,
  rules: { minMarketCapUsd: 40_000 },
  budget: { maxLaunchesPerDay: 8, maxSpendPerDay: '0.03' },
});
relay.start();`),
			p('Prove the rules against history before funding anything: ', el('code', {}, 'npx launch-relay backtest --limit 500'),
				' replays real graduations through the exact rules, mapper and budget the live relay uses, and switches off the rules that cannot be tested honestly on historical data rather than quietly selecting on the answer.'),
		],
	},
	{
		id: 'contracts',
		title: 'The contracts',
		body: () => [
			p('An atomic launcher, a locker with no owner, and a registry. Compiled artifacts are committed, so installing the package does not pull a Solidity compiler and the bytecode is reviewable in the same diff as its source.'),
			code(`npm run build:contracts       # recompile from contracts/
npm run contracts:simulate    # deploy and launch against live chain state
npm run contracts:deploy -- --dry-run
npm test                      # includes the on-chain suite`),
			p('Robinhood Chain serves ', el('code', {}, 'eth_simulateV1'),
				', so the tests deploy the real contracts on top of the current block and call the real factory, position manager and WETH. Testing a launcher against a mocked AMM proves the mock.'),
			p('Details and guarantees: ', el('a', { href: '/protocol.html' }, 'the protocol page'), '.'),
		],
	},
	{
		id: 'safety',
		title: 'Safety',
		body: () => [
			ul(
				li('Dry run is the default in the CLI, the library and the website.'),
				li('Live mode needs ', el('code', {}, 'LAUNCH_RELAY_ARMED=1'), ' set out of band, plus an approval per launch: a typed yes, a tap in Telegram, or an explicit standing authorisation bounded by the budget.'),
				li('Every launch is simulated immediately before it is signed. For a learned descriptor that simulation is the correctness proof for the parts of the call that were replayed rather than understood.'),
				li('The plan you approve is the transaction that gets sent. Nothing between planning and signing can change it except a staleness check, which refuses an old plan rather than rebuilding it silently.'),
				li('Venue descriptors record the implementation they were learned from. A proxy upgrade changes what replayed arguments mean without changing the address, the selector or the calldata, so ', el('code', {}, 'health()'), ' refuses to launch when the chain reports a different implementation.'),
			),
		],
	},
	{
		id: 'reference',
		title: 'Reference',
		body: () => [
			ul(
				li(src('README.md', 'README'), ' — the full guide, including rules, wallets, budgets and the ledger.'),
				li(src('docs/robinhood-chain.md'), ' — the chain: assets, AMM addresses, how each was verified, how to add a venue.'),
				li(src('docs/venues.md'), ' — the current catalog, rendered.'),
				li(src('CONTRIBUTING.md'), ' — adding a venue, naming a selector, binding a field.'),
				li(src('index.d.ts'), ' — TypeScript declarations for everything exported.'),
			),
			p('Catalog in this build: ', el('code', {}, `${fmtNumber(venues.length)} venues, ${fmtNumber(launchable.length)} launchable`),
				`, generated ${(catalog.generatedAt || '').slice(0, 10)}.`),
		],
	},
];

mount('#toc', el('div', { class: 'eyebrow' }, 'Contents'),
	el('div', { style: 'display:grid;gap:6px' },
		SECTIONS.map((section) => el('a', { href: `#${section.id}`, class: 'dim' }, section.title))));

mount('#body', SECTIONS.map((section, i) => el('div', { style: i ? 'margin-top:44px' : '' },
	el('h2', { id: section.id, style: 'scroll-margin-top:80px' }, section.title),
	section.body(),
)));
