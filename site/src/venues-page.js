// The venue catalog, browsable.
//
// The table is the product: a launchpad's fee, the fields it lets you set, and
// the error it returns when it will not take a launch are the three things
// that decide where somebody launches, and none of them are published
// anywhere else on this chain.

import {
	addrLink, catalog, clear, el, extLink, fmtDate, fmtEth, fmtNumber, fnName, launchable, mount,
	observedLaunches, renderChrome, shortAddress, txUrl, venues, REPO,
} from './shared.js';

renderChrome();

const q = document.querySelector('#q');
const state = document.querySelector('#state');
const sort = document.querySelector('#sort');
const list = document.querySelector('#list');

mount('#summary',
	`${fmtNumber(venues.length)} contracts on Robinhood Chain have launched a token. `,
	`${fmtNumber(launchable.length)} of them were driven through a full launch against live chain state and worked. `,
	`Learned from blocks ${fmtNumber(catalog.window?.fromBlock)}–${fmtNumber(catalog.window?.toBlock)} on ${fmtDate(catalog.generatedAt)}, `,
	`covering ${fmtNumber(observedLaunches)} launches.`,
);

// The URL is the state, so a filtered view is a link somebody can send.
function readUrl() {
	const params = new URLSearchParams(window.location.search);
	q.value = params.get('q') || '';
	state.value = params.get('state') || 'launchable';
	sort.value = params.get('sort') || 'launches';
	return params.get('venue');
}

function writeUrl() {
	const params = new URLSearchParams();
	if (q.value.trim()) params.set('q', q.value.trim());
	if (state.value !== 'launchable') params.set('state', state.value);
	if (sort.value !== 'launches') params.set('sort', sort.value);
	const search = params.toString();
	window.history.replaceState(null, '', search ? `?${search}` : window.location.pathname);
}

const matches = (venue, needle) => {
	if (!needle) return true;
	const hay = [venue.id, venue.label, venue.address, venue.launch?.signature, venue.kind, venue.evidence?.symbol]
		.filter(Boolean).join(' ').toLowerCase();
	return hay.includes(needle.toLowerCase());
};

const fieldCount = (venue) => venue.launch?.bindings?.length ?? 0;

function render() {
	writeUrl();
	const needle = q.value.trim();
	const wanted = state.value;
	let rows = venues.filter((venue) => {
		if (wanted === 'launchable' && !venue.usable) return false;
		if (wanted === 'refused' && venue.usable) return false;
		return matches(venue, needle);
	});

	const by = {
		launches: (a, b) => (b.observed?.launches ?? 0) - (a.observed?.launches ?? 0),
		fee: (a, b) => Number(BigInt(a.launch?.value ?? 0) - BigInt(b.launch?.value ?? 0)),
		fields: (a, b) => fieldCount(b) - fieldCount(a),
		name: (a, b) => (a.label || a.id).localeCompare(b.label || b.id),
	}[sort.value];
	rows = [...rows].sort(by);

	clear(list);
	if (!rows.length) {
		list.append(el('div', { class: 'empty' },
			el('p', { style: 'margin:0 0 8px' }, needle ? `Nothing matches “${needle}”.` : 'Nothing to show with these filters.'),
			el('button', { class: 'btn small', type: 'button', onclick: () => { q.value = ''; state.value = 'all'; render(); } }, 'Clear the filters'),
		));
		return;
	}

	list.append(el('div', { class: 'faint', style: 'font-size:13px;margin-bottom:10px' },
		`${fmtNumber(rows.length)} venue${rows.length === 1 ? '' : 's'}`));
	list.append(el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
		el('div', { class: 'scroll-x' },
			el('table', {},
				el('thead', {}, el('tr', {},
					el('th', {}, ''),
					el('th', {}, 'Venue'),
					el('th', { class: 'num' }, 'Launches'),
					el('th', { class: 'num' }, 'Fee'),
					el('th', {}, 'You can set'),
					el('th', {}, 'Entry point'),
				)),
				el('tbody', {}, rows.map(row)),
			),
		),
	));
}

function row(venue) {
	const detailsId = `d-${venue.id.replace(/[^a-z0-9-]/gi, '')}`;
	const badge = venue.usable
		? el('span', { class: 'tag ok', title: 'A substituted launch was simulated against the live contract and succeeded' }, 'live')
		: el('span', { class: 'tag bad', title: venue.reason || 'not launchable' }, 'no');

	const tr = el('tr', {},
		el('td', {}, badge),
		el('td', {},
			el('div', { style: 'font-weight:560' }, venue.label || venue.id),
			el('div', { class: 'faint mono', style: 'font-size:12px' }, venue.id),
		),
		el('td', { class: 'num mono' }, fmtNumber(venue.observed?.launches ?? 0)),
		el('td', { class: 'num mono nowrap' }, venue.usable ? `${fmtEth(venue.launch.value)} ETH` : '—'),
		el('td', {}, venue.usable
			? el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;max-width:340px' },
				venue.launch.bindings.map((b) => el('span', { class: 'tag' }, b.role)))
			: el('span', { class: 'faint', style: 'font-size:13px' }, venue.reason || 'unknown')),
		el('td', {},
			el('div', { class: 'mono', style: 'font-size:13px' }, fnName(venue) || '—'),
			addrLink(venue.address, { style: 'font-size:12px' }),
		),
	);

	const detail = el('tr', { id: detailsId, hidden: true }, el('td', { colspan: '6', style: 'background:var(--bg-sunken)' }, detailPanel(venue)));
	tr.style.cursor = 'pointer';
	tr.addEventListener('click', () => { detail.hidden = !detail.hidden; });
	tr.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); detail.hidden = !detail.hidden; }
	});
	tr.tabIndex = 0;
	tr.setAttribute('aria-controls', detailsId);
	return [tr, detail];
}

function detailPanel(venue) {
	const rows = [];
	if (venue.launch?.signature) rows.push(['Launch function', el('code', {}, venue.launch.signature)]);
	if (venue.implementation) rows.push(['Implementation', addrLink(venue.implementation)]);
	if (venue.kind) rows.push(['Kind', venue.kind]);
	if (venue.quote) rows.push(['Quote asset', el('span', {}, venue.quote.symbol, ' ', addrLink(venue.quote.token))]);

	const spread = venue.launch?.valueObserved;
	if (spread && spread.max !== spread.min) {
		rows.push(['Observed fees', `${fmtEth(spread.min)} to ${fmtEth(spread.max)} ETH across ${spread.samples} launches. The higher ones include a creator buy; a launch here pays the floor.`]);
	}
	if (venue.labelEvidence) rows.push(['Named by', `${venue.labelSource} — ${venue.labelEvidence}`]);
	if (venue.overrideReason) rows.push(['Curated', venue.overrideReason]);

	if (venue.evidence?.txHash) {
		rows.push(['Learned from', el('span', {},
			extLink(txUrl(venue.evidence.txHash), shortAddress(venue.evidence.txHash, 6), { class: 'mono' }),
			` — launched ${venue.evidence.name || '?'} (${venue.evidence.symbol || '?'}) at `,
			addrLink(venue.evidence.token),
		)]);
	}

	for (const rejected of venue.probe?.rejected || []) {
		rows.push([`Replayed, not yours`, `argument ${rejected.path.join('.')} looked like the ${rejected.role}, but the venue rejects a new value${rejected.revert ? ` (${rejected.revert})` : ''}`]);
	}
	if (!venue.usable && venue.reason) rows.push(['Why it is refused', venue.reason]);

	return el('div', { style: 'padding:6px 0 10px;display:grid;gap:10px' },
		rows.map(([label, value]) => el('div', { style: 'display:grid;grid-template-columns:minmax(120px,160px) 1fr;gap:14px;align-items:baseline' },
			el('div', { class: 'faint', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.05em' }, label),
			el('div', { style: 'font-size:13px;min-width:0;overflow-wrap:anywhere' }, value),
		)),
		venue.usable
			? el('div', { style: 'margin-top:6px;display:flex;gap:8px;flex-wrap:wrap' },
				el('a', { class: 'btn small primary', href: `/launch.html?venue=${encodeURIComponent(venue.id)}` }, `Launch on ${venue.label || venue.id}`),
				extLink(`${REPO}/blob/main/src/chains/robinhood/venues/catalog.json`, 'Raw descriptor', { class: 'btn small ghost' }),
			)
			: null,
	);
}

for (const control of [q, state, sort]) {
	control.addEventListener('input', render);
	control.addEventListener('change', render);
}

readUrl();
render();
