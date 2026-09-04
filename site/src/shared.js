// Everything the pages share: the chain client, the catalog, formatting, and
// the bits of chrome that would otherwise be copied into four HTML files.

import { createPublicClient, defineChain, formatEther, http } from 'viem';
import catalog from '../../src/chains/robinhood/venues/catalog.json';
import { AMMS, TOKENS } from '../../src/chains/robinhood/contracts.js';

export const CHAIN_ID = 4663;
export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const REPO = 'https://github.com/nirholas/launch-relay';

export const chain = defineChain({
	id: CHAIN_ID,
	name: 'Robinhood Chain',
	nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	rpcUrls: { default: { http: [RPC_URL] } },
	blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } },
});

export const publicClient = createPublicClient({
	chain,
	transport: http(RPC_URL, { retryCount: 3, retryDelay: 1_500, timeout: 30_000 }),
});

export { catalog, AMMS, TOKENS, formatEther };

export const venues = catalog.venues;
export const launchable = venues.filter((v) => v.usable);

/** Every launch discovery attributed to a contract, across the whole catalog. */
export const observedLaunches = venues.reduce((sum, v) => sum + (v.observed?.launches ?? 0), 0);

// ── formatting ────────────────────────────────────────────────────────────

export const shortAddress = (value, size = 4) =>
	typeof value === 'string' && value.length > 12 ? `${value.slice(0, 2 + size)}…${value.slice(-size)}` : String(value ?? '');

export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address) => `${EXPLORER}/address/${address}`;
export const tokenUrl = (address) => `${EXPLORER}/token/${address}`;

export function fmtNumber(value) {
	return Number(value ?? 0).toLocaleString('en-US');
}

/** Wei as ETH, trimmed to something a person reads rather than parses. */
export function fmtEth(wei) {
	const value = Number(formatEther(BigInt(wei ?? 0)));
	if (value === 0) return '0';
	if (value < 0.000001) return value.toExponential(2);
	return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function fmtDate(value) {
	if (!value) return 'unknown';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
}

export function fnName(venue) {
	return venue.launch?.signature?.split('(')[0] ?? '';
}

// ── DOM ───────────────────────────────────────────────────────────────────

/**
 * Build an element. Children may be nodes or strings; strings are set as text
 * rather than HTML, which is the whole reason this exists: the catalog carries
 * venue labels and revert strings that came off a public chain, and none of it
 * is ever parsed as markup.
 */
export function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === null || value === undefined || value === false) continue;
		if (key === 'class') node.className = value;
		else if (key === 'dataset') Object.assign(node.dataset, value);
		else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
		else node.setAttribute(key, value === true ? '' : String(value));
	}
	// Flattened all the way down: a helper that returns two rows (a row and its
	// detail row) is a natural thing to map over, and a single-level flatten
	// turns that array into the string "[object HTMLTableRowElement]".
	for (const child of children.flat(Infinity)) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

export function mount(selector, ...children) {
	const host = document.querySelector(selector);
	if (!host) return null;
	clear(host).append(...children.flat().filter(Boolean));
	return host;
}

/** An external link that cannot be used to reach back into this page. */
export const extLink = (href, text, props = {}) =>
	el('a', { href, target: '_blank', rel: 'noopener noreferrer', ...props }, text);

export const addrLink = (address, props = {}) =>
	extLink(addressUrl(address), shortAddress(address), { class: 'mono', title: address, ...props });

// ── chrome ────────────────────────────────────────────────────────────────

const NAV = [
	['/', 'Home'],
	['/venues.html', 'Venues'],
	['/launch.html', 'Launch'],
	['/protocol.html', 'Protocol'],
	['/docs.html', 'Docs'],
];

export function renderChrome() {
	const path = window.location.pathname.replace(/index\.html$/, '') || '/';
	const header = document.querySelector('header.site .wrap');
	if (header) {
		header.append(
			el('a', { class: 'brand', href: '/' }, el('span', { class: 'dot' }), 'Relay'),
			el('nav', { class: 'site' },
				NAV.map(([href, label]) =>
					el('a', { href, 'aria-current': href === path ? 'page' : null }, label)),
				el('button', {
					class: 'btn ghost small',
					type: 'button',
					title: 'Switch between light and dark',
					onclick: toggleTheme,
				}, 'Theme'),
				extLink(REPO, 'GitHub', { class: 'btn small' }),
			),
		);
	}

	const footer = document.querySelector('footer.site .wrap');
	if (footer) {
		footer.append(
			el('span', {}, `Robinhood Chain · chain ${CHAIN_ID}`),
			el('span', { class: 'spacer' }),
			extLink(EXPLORER, 'Explorer'),
			extLink(`${REPO}#readme`, 'Documentation'),
			extLink(`${REPO}/blob/main/LICENSE`, 'Apache-2.0'),
		);
	}

	restoreTheme();
}

function toggleTheme() {
	const current = document.documentElement.dataset.theme
		|| (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
	const next = current === 'dark' ? 'light' : 'dark';
	document.documentElement.dataset.theme = next;
	try { localStorage.setItem('relay.theme', next); } catch { /* private windows refuse; the page still works */ }
}

function restoreTheme() {
	try {
		const saved = localStorage.getItem('relay.theme');
		if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
	} catch { /* nothing to restore */ }
}
