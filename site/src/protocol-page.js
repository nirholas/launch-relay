// The protocol page: what the contracts are, what they guarantee, and whether
// they are deployed yet.
//
// The deployment panel reads the same deployments.json the library and the CLI
// read. An undeployed protocol says so plainly and shows the command that
// deploys it, rather than printing an address that is not there.

import deployments from '../../src/chains/robinhood/deployments.json';
import { CHAIN_ID, addrLink, clear, el, extLink, fmtNumber, mount, renderChrome, REPO } from './shared.js';

renderChrome();

const source = (path) => `${REPO}/blob/main/${path}`;

// ── deployment status ─────────────────────────────────────────────────────

const record = deployments.chains?.[String(CHAIN_ID)];
const deployed = Boolean(record?.launcher);

mount('#deployment', el('div', { class: 'wrap' }, el('div', { class: 'card' },
	el('div', { class: 'eyebrow' }, deployed ? 'Live on Robinhood Chain' : 'Not deployed yet'),
	deployed
		? el('div', { style: 'display:grid;gap:8px;font-size:14px' },
			row('Launcher', addrLink(record.launcher)),
			row('Locker', addrLink(record.locker)),
			row('Registry', addrLink(record.registry)),
			...Object.entries(record.adapters || {}).map(([id, address]) => row(id, addrLink(address))),
			row('Deployed', record.deployedAt?.slice(0, 10) || 'unknown'),
		)
		: el('div', {},
			el('p', { style: 'margin:0 0 12px' },
				'The contracts are written, compiled, and proved against live chain state on every test run, but they are not deployed. ',
				'Until they are, launch through a catalogued venue or open a pool of your own; both work today and neither needs this protocol.'),
			el('pre', { style: 'margin:0 0 10px' }, el('code', {},
				'npm run contracts:simulate                 # prove it against the live chain\n'
				+ 'npm run contracts:deploy -- --dry-run       # price the deployment\n'
				+ 'npm run contracts:deploy -- --confirm       # send it')),
			el('p', { class: 'faint', style: 'margin:0;font-size:13px' },
				'Deploying writes the addresses into ', el('code', {}, 'deployments.json'),
				', which this page, the library and the CLI all read.'),
		),
)));

function row(label, value) {
	return el('div', { style: 'display:grid;grid-template-columns:minmax(90px,120px) 1fr;gap:12px;align-items:baseline' },
		el('span', { class: 'faint', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.05em' }, label),
		el('span', { style: 'min-width:0;overflow-wrap:anywhere' }, value),
	);
}

// ── contracts ─────────────────────────────────────────────────────────────

const CONTRACTS = [
	{
		name: 'RelayLauncher',
		path: 'contracts/RelayLauncher.sol',
		blurb: 'Deploys the token with CREATE2, routes to an AMM adapter to open the pool, sends the position straight to the locker, and records the launch. All or nothing.',
		points: [
			'The token address is computable before the transaction, and the salt is namespaced by the creator so nobody else can take it.',
			'The position is never in the creator\'s hands, so there is no moment where a launch advertising locked liquidity does not have it.',
			'Adapters must end every call holding nothing, and the launcher checks rather than trusting them.',
		],
	},
	{
		name: 'LiquidityLocker',
		path: 'contracts/LiquidityLocker.sol',
		blurb: 'Holds an LP balance or a position NFT. Lets the beneficiary collect trading fees. Lets nobody take the liquidity back early.',
		points: [
			'No owner, no admin, no upgrade path. There is nothing on this contract to compromise.',
			'A permanent lock has no branch that releases it, for anyone, ever.',
			'A lock can be extended and never shortened, which is what makes the original commitment worth reading.',
		],
	},
	{
		name: 'LaunchRegistry',
		path: 'contracts/LaunchRegistry.sol',
		blurb: 'One record per launch, in one shape, whichever venue it happened on. Permissionless to write, impossible to forge.',
		points: [
			'Anyone can register: a registry only its owner can write to is a registry only its owner can censor.',
			'Records carry who wrote them, and only an authorised launcher\'s record is flagged as having gone through this protocol.',
			'First writer wins, so a second record cannot rewrite the first.',
		],
	},
	{
		name: 'LaunchToken',
		path: 'contracts/LaunchToken.sol',
		blurb: 'A fixed-supply ERC-20 with no owner, no mint, no pause, and no upgrade path. The constructor is the only place supply can ever come from.',
		points: [
			'A launch token whose deployer can mint more of it is not a launch, it is a promise.',
			'The metadata URI is set once, in the constructor, and cannot change afterwards either.',
		],
	},
];

mount('#contracts', CONTRACTS.map((contract) => el('div', { class: 'card' },
	el('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' },
		el('h3', { style: 'margin:0' }, contract.name),
		extLink(source(contract.path), 'source', { style: 'font-size:13px' }),
	),
	el('p', { style: 'margin:10px 0 12px' }, contract.blurb),
	el('ul', { style: 'margin:0;padding-left:18px;color:var(--text-dim);font-size:13px;display:grid;gap:6px' },
		contract.points.map((point) => el('li', {}, point))),
)));

// ── guarantees ────────────────────────────────────────────────────────────

const GUARANTEES = [
	['Atomic', 'The token cannot exist without its pool. A launch that fails anywhere leaves nothing behind, including no orphaned token with a supply and no market.'],
	['Address known in advance', 'CREATE2 over a salt hashed with the creator\'s address. You are shown the token address before you sign, and the test suite fails if the launcher disagrees with the prediction.'],
	['Locked on arrival', 'The position goes adapter to locker inside the same transaction. It is never held by the creator, and a permanent lock is permanent in the sense that no function releases it.'],
	['Fees stay with the creator', 'A locked concentrated position still accrues trading fees, and only the beneficiary can collect them. The beneficiary is transferable, because fee rights on a locked position are a real asset.'],
	['No upgrade path', 'None of the three contracts is a proxy. What is deployed is what runs, for as long as it is deployed.'],
	['Proved, not asserted', 'Every claim on this page is a test that runs against live chain state, including the refusals. Mocking an AMM proves the mock.'],
];

mount('#guarantees', GUARANTEES.map(([title, body]) => el('div', { class: 'card' },
	el('div', { style: 'display:flex;gap:9px;align-items:center;margin-bottom:8px' },
		el('span', { class: 'tag ok' }, 'structural'),
		el('h3', { style: 'margin:0' }, title),
	),
	el('p', { style: 'margin:0' }, body),
)));

// ── governance ────────────────────────────────────────────────────────────

mount('#governance',
	el('div', { class: 'card' },
		el('h3', {}, 'What the owner can do'),
		el('ul', { style: 'margin:0;padding-left:18px;color:var(--text-dim);display:grid;gap:8px' },
			el('li', {}, 'Register a new AMM adapter, or disable one.'),
			el('li', {}, 'Set a protocol fee, up to a cap that is a constant in the contract rather than a setting.'),
			el('li', {}, 'Hand ownership to somebody else, in two steps, so a mistyped address cannot orphan it.'),
		),
	),
	el('div', { class: 'card' },
		el('h3', {}, 'What the owner cannot do'),
		el('ul', { style: 'margin:0;padding-left:18px;color:var(--text-dim);display:grid;gap:8px' },
			el('li', {}, 'Touch a lock, or withdraw anyone\'s liquidity. The locker has no owner at all.'),
			el('li', {}, 'Change a token that has already launched, or mint more of one.'),
			el('li', {}, 'Raise the fee past the cap. One basis point over reverts, and the test suite checks it.'),
			el('li', {}, 'Upgrade any of this. There is no proxy.'),
		),
		el('p', { class: 'faint', style: 'margin:14px 0 0;font-size:13px' },
			'Disabling every adapter is the worst governance can do, and that stops new launches without touching old ones.'),
	),
);

// ── gas ───────────────────────────────────────────────────────────────────

const GAS = [
	['Deploy the whole protocol', 7_189_503, 'once, ever'],
	['Launch: one-sided Uniswap V3', 5_985_546, 'deploy, initialise, mint, lock, record'],
	['Launch: two-sided Uniswap V2', 3_527_298, 'deploy, pair, add liquidity, lock, record'],
];

mount('#gas',
	el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
		el('div', { class: 'scroll-x' }, el('table', {},
			el('thead', {}, el('tr', {},
				el('th', {}, 'Operation'),
				el('th', { class: 'num' }, 'Gas'),
				el('th', {}, 'What that covers'),
			)),
			el('tbody', {}, GAS.map(([label, gas, covers]) => el('tr', {},
				el('td', {}, label),
				el('td', { class: 'num mono' }, fmtNumber(gas)),
				el('td', { class: 'dim' }, covers),
			))),
		)),
	),
	el('p', { class: 'faint', style: 'margin:14px 0 0;font-size:13px' },
		'Measured by ', el('code', {}, 'npm run contracts:simulate'), ' against live chain state, not estimated. ',
		'Re-run it to get today\'s numbers at today\'s gas price.'),
);
