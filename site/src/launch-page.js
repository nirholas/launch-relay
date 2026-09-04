// The launch composer.
//
// This page does not reimplement launching. It builds a spec and a wallet
// handle and hands them to the same targets the command line uses, so a plan
// shown here is the plan the library produces, and the transaction sent is the
// one the plan priced. A second implementation would be a second set of bugs.

import { createRobinhoodVenueTarget } from '../../src/chains/robinhood/target.js';
import { createPoolLaunchTarget } from '../../src/chains/robinhood/amm/pool-target.js';
import {
	AMMS, addrLink, clear, el, extLink, fmtEth, launchable, mount, publicClient, renderChrome,
	shortAddress, tokenUrl, txUrl,
} from './shared.js';
import { NoWalletError, connect, currentAccount, hasWallet, onWalletChange, walletClient, walletHandle } from './wallet.js';

renderChrome();

const form = document.querySelector('#form');
const mode = document.querySelector('#mode');
const venueSelect = document.querySelector('#venue');
const ammSelect = document.querySelector('#amm');
const poolType = document.querySelector('#poolType');
const quoteSelect = document.querySelector('#quote');
const feeSelect = document.querySelector('#fee');
const quoteAmountField = document.querySelector('#quote-amount-field');
const planButton = document.querySelector('#plan');

const log = { info: console.info, warn: console.warn, error: console.error, debug: () => {} };

/** An address with no key, used only so a plan can be priced from somewhere. */
const READ_ONLY = '0x0000000000000000000000000000000000000001';

let account = null;
let plan = null;
let target = null;

// ── wallet panel ──────────────────────────────────────────────────────────

function renderWallet() {
	const panel = document.querySelector('#wallet');
	clear(panel);
	panel.append(el('div', { class: 'eyebrow' }, 'Wallet'));

	if (!hasWallet()) {
		panel.append(
			el('p', { style: 'margin:0 0 10px' }, 'No wallet in this browser.'),
			el('p', { class: 'faint', style: 'margin:0;font-size:13px' },
				'You can still price a launch here. To send one, install a wallet extension, or use ',
				el('code', {}, 'npx launch-relay launch'), '.'),
		);
		return;
	}
	if (!account) {
		panel.append(
			el('p', { class: 'faint', style: 'margin:0 0 12px;font-size:13px' },
				'Connect to price the launch from your own address and to send it.'),
			el('button', { class: 'btn primary', type: 'button', onclick: doConnect }, 'Connect wallet'),
		);
		return;
	}
	panel.append(
		el('div', { class: 'mono', style: 'font-size:14px' }, shortAddress(account, 6)),
		el('div', { class: 'faint', id: 'balance', style: 'font-size:13px;margin-top:4px' }, 'reading balance…'),
	);
	publicClient.getBalance({ address: account })
		.then((wei) => setText('#balance', `${fmtEth(wei)} ETH on Robinhood Chain`))
		.catch(() => setText('#balance', 'balance unavailable'));
}

const setText = (selector, text) => { const node = document.querySelector(selector); if (node) node.textContent = text; };

async function doConnect() {
	try {
		const result = await connect();
		account = result.address;
		renderWallet();
		// A plan priced from a read-only address has to be rebuilt, because the
		// launching wallet is part of what gets signed.
		if (plan) { plan = null; renderPlan(null); }
	} catch (err) {
		showError(err instanceof NoWalletError ? err.message : `Could not connect: ${short(err)}`);
	}
}

// ── form wiring ───────────────────────────────────────────────────────────

for (const venue of launchable) {
	venueSelect.append(el('option', { value: venue.id },
		`${venue.label || venue.id} — ${venue.observed.launches} launches, ${fmtEth(venue.launch.value)} ETH`));
}
if (!launchable.length) {
	venueSelect.append(el('option', { value: '' }, 'no venues in this build'));
	venueSelect.disabled = true;
}

for (const [value, label] of [['ETH', 'ETH (native)'], ['WETH', 'WETH'], ['USDG', 'USDG'], ['VIRTUAL', 'VIRTUAL']]) {
	quoteSelect.append(el('option', { value }, label));
}

function syncPoolFields() {
	const amm = ammSelect.value;
	const tiers = AMMS[amm]?.feeTiers;
	clear(feeSelect);
	if (tiers) {
		for (const fee of Object.keys(tiers)) {
			feeSelect.append(el('option', { value: fee, selected: fee === '10000' }, `${Number(fee) / 10_000}%`));
		}
		feeSelect.disabled = false;
	} else {
		feeSelect.append(el('option', { value: '' }, '0.30% (fixed)'));
		feeSelect.disabled = true;
	}

	// A constant-product pool has no ranges, so it cannot be one-sided, and a
	// V3 pool has no native side: it quotes in WETH either way.
	const v2 = amm === 'uniswap-v2';
	if (v2) poolType.value = 'full-range';
	poolType.disabled = v2;
	for (const option of quoteSelect.options) {
		option.disabled = option.value === 'ETH' && amm === 'uniswap-v3';
	}
	if (quoteSelect.value === 'ETH' && amm === 'uniswap-v3') quoteSelect.value = 'WETH';

	const twoSided = poolType.value === 'full-range';
	quoteAmountField.hidden = !twoSided;
	document.querySelector('#startFdv').closest('.field').hidden = twoSided;
}

function syncMode() {
	const isVenue = mode.value === 'venue';
	document.querySelector('#venue-fields').hidden = !isVenue;
	document.querySelector('#pool-fields').hidden = isVenue;
	if (isVenue) renderVenueNote();
	else syncPoolFields();
	invalidate();
}

function invalidate() {
	plan = null;
	target = null;
	renderPlan(null);
}

function renderVenueNote() {
	const venue = launchable.find((v) => v.id === venueSelect.value);
	const note = document.querySelector('#venue-note');
	clear(note);
	if (!venue) return;
	note.append(el('div', { class: 'faint', style: 'font-size:13px;margin:-8px 0 16px' },
		'Sets ',
		el('span', { class: 'mono' }, venue.launch.bindings.map((b) => b.role).join(', ')),
		'. Everything else replays a launch that already worked on this contract. ',
		el('a', { href: `/venues.html?q=${encodeURIComponent(venue.id)}&state=all` }, 'Details'),
	));
}

mode.addEventListener('change', syncMode);
venueSelect.addEventListener('change', () => { renderVenueNote(); invalidate(); });
for (const control of [ammSelect, poolType, quoteSelect, feeSelect]) {
	control.addEventListener('change', () => { syncPoolFields(); invalidate(); });
}
for (const control of form.querySelectorAll('input, textarea')) {
	control.addEventListener('input', () => { if (plan) invalidate(); });
}
form.addEventListener('reset', () => { setTimeout(syncMode, 0); });

// A venue can be pre-selected from the catalog page.
const requested = new URLSearchParams(window.location.search).get('venue');
if (requested && launchable.some((v) => v.id === requested)) {
	mode.value = 'venue';
	venueSelect.value = requested;
}

// ── planning ──────────────────────────────────────────────────────────────

function buildSpec() {
	const name = form.name.value.trim();
	const symbol = form.symbol.value.trim().toUpperCase();
	if (!name || !symbol) throw new Error('a name and a symbol are required');
	return {
		name,
		symbol,
		description: form.description.value.trim(),
		imageUrl: form.image.value.trim() || null,
		links: { twitter: null, telegram: null, website: null },
		origin: { source: 'relay-web', chain: 'robinhood', signalId: `web:${symbol}:${Date.now()}` },
	};
}

function buildTarget() {
	if (mode.value === 'venue') {
		if (!venueSelect.value) throw new Error('no venue is selected');
		return createRobinhoodVenueTarget({ venue: venueSelect.value });
	}
	const type = poolType.value;
	return createPoolLaunchTarget({
		amm: ammSelect.value,
		quote: quoteSelect.value,
		poolType: type,
		fee: feeSelect.value ? Number(feeSelect.value) : undefined,
		startFdv: type === 'single-sided' ? Number(document.querySelector('#startFdv').value) : undefined,
		quoteAmount: type === 'full-range' ? document.querySelector('#quoteAmount').value : undefined,
	});
}

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	planButton.disabled = true;
	renderPlanning();
	try {
		const spec = buildSpec();
		target = buildTarget();
		// Without a wallet the plan is still built and simulated, from a
		// read-only address, so the cost is visible before installing anything.
		// `dryRun` keeps that path from publishing metadata anywhere.
		const address = account || READ_ONLY;
		const handle = walletHandle({ address, client: account ? walletClient(account) : null, publicClient });
		plan = await target.plan(spec, { wallet: handle, log, dryRun: !account });
		renderPlan(plan);
	} catch (err) {
		plan = null;
		showError(short(err));
	} finally {
		planButton.disabled = false;
	}
});

function renderPlanning() {
	mount('#plan-panel',
		el('div', { class: 'eyebrow' }, 'Plan'),
		el('div', { style: 'display:grid;gap:8px' }, [1, 2, 3, 4, 5].map(() => el('div', { class: 'skeleton' }))),
		el('div', { class: 'faint', style: 'font-size:13px;margin-top:12px' }, 'simulating against the live chain…'),
	);
}

function renderPlan(current) {
	const panel = document.querySelector('#plan-panel');
	clear(panel);
	panel.append(el('div', { class: 'eyebrow' }, 'Plan'));

	if (!current) {
		panel.append(el('p', { class: 'faint', style: 'margin:0;font-size:13px' },
			'Fill the form and press Price it. Nothing is sent until you approve a priced plan.'));
		return;
	}

	panel.append(el('pre', { style: 'margin:0 0 14px;font-size:12px' }, el('code', {}, current.summary.join('\n'))));

	for (const warning of current.warnings || []) {
		panel.append(el('div', { class: 'notice', style: 'margin-bottom:10px' }, warning));
	}

	if (current.dryRun) {
		panel.append(
			el('p', { class: 'faint', style: 'font-size:13px' },
				'Priced from a read-only address. Connect a wallet and price it again to send it.'),
			el('button', { class: 'btn primary', type: 'button', onclick: doConnect }, 'Connect wallet'),
		);
		return;
	}

	panel.append(
		el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
			el('button', { class: 'btn primary', type: 'button', id: 'send', onclick: send },
				`Launch for ${current.cost.totalNative} ETH`),
			el('button', { class: 'btn ghost', type: 'button', onclick: invalidate }, 'Discard'),
		),
		el('p', { class: 'faint', style: 'font-size:12px;margin:12px 0 0' },
			'Signing spends real funds. What is above is what gets sent, and it is re-simulated immediately before signing.'),
	);
}

async function send() {
	const button = document.querySelector('#send');
	if (button) { button.disabled = true; button.textContent = 'waiting for the wallet…'; }
	try {
		const handle = walletHandle({ address: account, client: walletClient(account), publicClient });
		renderResult(await target.execute(plan, { wallet: handle, log }));
	} catch (err) {
		showError(short(err));
		if (button) { button.disabled = false; button.textContent = 'Try again'; }
	}
}

function renderResult(result) {
	const panel = document.querySelector('#plan-panel');
	clear(panel);
	panel.append(el('div', { class: 'eyebrow' }, result.ok ? 'Launched' : 'Failed'));

	if (!result.ok) {
		panel.append(
			el('div', { class: 'error', style: 'margin-bottom:12px' }, result.error || 'the transaction reverted'),
			result.txHash ? extLink(txUrl(result.txHash), 'View the transaction', { class: 'btn small' }) : null,
		);
		return;
	}

	panel.append(
		el('p', { style: 'margin:0 0 12px' }, 'The coin exists and its market is open.'),
		el('div', { style: 'display:grid;gap:8px;font-size:13px' },
			result.tokenAddress ? el('div', {}, 'Token: ', addrLink(result.tokenAddress)) : null,
			el('div', {}, 'Transaction: ', extLink(txUrl(result.txHash), shortAddress(result.txHash, 6), { class: 'mono' })),
		),
		el('div', { style: 'display:flex;gap:10px;margin-top:16px;flex-wrap:wrap' },
			result.tokenAddress ? extLink(tokenUrl(result.tokenAddress), 'Open in the explorer', { class: 'btn small primary' }) : null,
			el('button', { class: 'btn small ghost', type: 'button', onclick: () => { form.reset(); syncMode(); } }, 'Launch another'),
		),
	);
}

function showError(message) {
	mount('#plan-panel', el('div', { class: 'eyebrow' }, 'Plan'), el('div', { class: 'error' }, message));
}

const short = (err) => String(err?.shortMessage || err?.details || err?.message || err).split('\n')[0].slice(0, 400);

// ── boot ──────────────────────────────────────────────────────────────────

onWalletChange(({ address }) => {
	if (address !== undefined) account = address;
	invalidate();
	renderWallet();
});

currentAccount().then((existing) => { account = existing; renderWallet(); });
renderWallet();
syncMode();
