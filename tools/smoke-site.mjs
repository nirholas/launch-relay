#!/usr/bin/env node
// Load every built page in a real browser and fail on anything a human would
// notice.
//
//   npm run site:smoke
//
// A static site is exactly the kind of thing that builds green and renders
// nothing: a bundle that throws on load, a table that stringifies its rows
// instead of appending them, a filter that matches everything. None of that
// shows up in a build log, and all of it shows up here.
//
// The last check is the important one. It fills the launch form and prices a
// real launch against the live chain, from a read-only address, so a broken
// bundle or a broken venue descriptor fails the build rather than the first
// person to open the page.
//
// Playwright is not a dependency of this package. If it cannot be found the
// script says so and exits zero, because a browser that is not installed is
// not a failing site.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(root, 'site/dist');

const playwright = await loadPlaywright();
if (!playwright) {
	console.log('playwright is not installed; skipping the browser smoke test.');
	console.log('install it with: npm i -D playwright && npx playwright install chromium');
	process.exit(0);
}

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.map': 'application/json',
	'.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
	let path = decodeURIComponent(req.url.split('?')[0]);
	if (path.endsWith('/')) path += 'index.html';
	const file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
	try {
		await stat(file);
		res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
		res.end(await readFile(file));
	} catch {
		res.writeHead(404, { 'content-type': MIME['.html'] });
		res.end(await readFile(join(DIST, '404.html')).catch(() => 'not found'));
	}
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await playwright.chromium.launch();
let failures = 0;
const report = (ok, label, detail = '') => {
	if (!ok) failures++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(18)} ${detail}`);
};

const PAGES = [
	['/', ['Launch on anything', 'launch venues found on chain']],
	['/venues.html', ['Launch venues', 'contracts on Robinhood Chain']],
	['/launch.html', ['Launch a coin', 'WHERE IT LAUNCHES']],
	['/protocol.html', ['One transaction']],
	['/docs.html', ['Documentation']],
	['/does-not-exist', ['No such page']],
];

for (const [path, expected] of PAGES) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const problems = [];
	page.on('console', (message) => {
		if (message.type() !== 'error') return;
		// The 404 page legitimately reports its own 404. That is the test.
		if (path === '/does-not-exist' && message.text().includes('404')) return;
		problems.push(`console: ${message.text().slice(0, 180)}`);
	});
	page.on('pageerror', (error) => problems.push(`pageerror: ${String(error).slice(0, 180)}`));

	const response = await page.goto(base + path, { waitUntil: 'networkidle' });
	const text = await page.locator('body').innerText();
	const missing = expected.filter((needle) => !text.includes(needle));
	const nav = await page.locator('header.site nav a').count();
	const foot = await page.locator('footer.site a').count();
	report(
		!problems.length && !missing.length && nav >= 4 && foot >= 2,
		path,
		`status=${response?.status()} nav=${nav} foot=${foot}`
		+ (missing.length ? ` missing=${JSON.stringify(missing)}` : '')
		+ (problems.length ? `\n      ${problems.join('\n      ')}` : ''),
	);
	await context.close();
}

const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

await page.goto(`${base}/venues.html`, { waitUntil: 'networkidle' });
const all = await page.locator('tbody tr').count();
await page.fill('#q', 'virtuals');
await page.waitForTimeout(150);
const filtered = await page.locator('tbody tr').count();
await page.fill('#q', 'no-such-venue-anywhere');
await page.waitForTimeout(150);
const emptyState = await page.locator('.empty').count();
report(all > 0 && filtered > 0 && filtered < all && emptyState === 1,
	'venues filter', `rows ${all} -> filtered ${filtered} -> empty state ${emptyState}`);

await page.goto(`${base}/launch.html`, { waitUntil: 'networkidle' });
await page.selectOption('#mode', 'pool');
await page.waitForTimeout(120);
const poolVisible = await page.locator('#pool-fields').isVisible();
await page.selectOption('#amm', 'uniswap-v2');
await page.waitForTimeout(120);
const shapeLocked = await page.locator('#poolType').isDisabled();
report(poolVisible && shapeLocked, 'launch form', `pool fields=${poolVisible}, v2 forces two-sided=${shapeLocked}`);

await page.selectOption('#mode', 'venue');
await page.fill('#name', 'Loop Rat');
await page.fill('#symbol', 'LOOPRAT');
await page.click('#plan');
await page.waitForFunction(() => {
	const panel = document.querySelector('#plan-panel');
	return Boolean(panel?.querySelector('pre') || panel?.querySelector('.error'));
}, null, { timeout: 90_000 }).catch(() => {});
const planText = await page.locator('#plan-panel').innerText();
report(/total/i.test(planText) && /ETH/.test(planText), 'live pricing',
	planText.split('\n').filter(Boolean).slice(1, 3).join(' | ').slice(0, 130));

if (errors.length) {
	failures++;
	console.log(`FAIL  page errors        ${errors.slice(0, 3).join(' | ').slice(0, 300)}`);
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nevery page loads, renders, and prices a real launch');
process.exit(failures ? 1 : 0);

/** Playwright, from this package or from anywhere else on the machine. */
async function loadPlaywright() {
	const require = createRequire(import.meta.url);
	for (const specifier of ['playwright', 'playwright-core', process.env.PLAYWRIGHT_PATH]) {
		if (!specifier) continue;
		try {
			const module = require(specifier);
			if (module?.chromium) return module;
		} catch { /* try the next one */ }
	}
	return null;
}
