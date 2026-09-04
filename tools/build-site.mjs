#!/usr/bin/env node
// Build the site into site/dist.
//
//   npm run site:build
//   npm run site:dev     (rebuild on change, served on :8000)
//
// esbuild bundles each page's entry module, viem included, so the site is
// static files with no runtime dependency on a CDN and no import map to get
// wrong. The venue catalog is bundled too: the pages read the same JSON the
// library does, which is why the numbers on the site cannot drift from the
// numbers in the code.

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(root, 'site');
const OUT = join(SITE, 'dist');

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const pages = (await readdir(SITE)).filter((name) => name.endsWith('.html'));
const entries = (await readdir(join(SITE, 'src'))).filter((name) => name.endsWith('.js') && name !== 'shared.js');

const options = {
	entryPoints: entries.map((name) => join(SITE, 'src', name)),
	outdir: join(OUT, 'src'),
	bundle: true,
	format: 'esm',
	target: ['es2022'],
	splitting: true,
	minify: !watch,
	sourcemap: watch ? 'inline' : false,
	logLevel: 'info',
	// The chain modules import JSON with an import attribute, which esbuild
	// resolves natively; nothing here needs a loader plugin.
	define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

async function copyStatic() {
	for (const page of pages) await cp(join(SITE, page), join(OUT, page));
	await cp(join(SITE, 'styles.css'), join(OUT, 'styles.css'));
	try {
		await cp(join(SITE, 'public'), OUT, { recursive: true });
	} catch { /* no public assets is fine */ }
	// A tiny 404 that keeps the chrome, so a mistyped path is not a blank page.
	await writeFile(join(OUT, '404.html'), await notFoundPage());
}

async function notFoundPage() {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found — Relay</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="site"><div class="wrap"></div></header>
<main><section><div class="wrap narrow">
  <h1>No such page</h1>
  <p>The link is wrong or the page moved.</p>
  <a class="btn primary" href="/">Back to the start</a>
</div></section></main>
<footer class="site"><div class="wrap"></div></footer>
<script type="module" src="/src/notfound.js"></script>
</body>
</html>
`;
}

if (watch || serve) {
	const context = await esbuild.context(options);
	await copyStatic();
	await context.watch();
	const server = await context.serve({ servedir: OUT, port: 8000, host: '0.0.0.0' });
	console.log(`\nserving http://localhost:${server.port} from site/dist\n`);
} else {
	const result = await esbuild.build({ ...options, metafile: true });
	await copyStatic();
	const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
	console.log(`\nbuilt ${pages.length} page(s) and ${entries.length} bundle(s), ${(bytes / 1024).toFixed(0)} kB total, into site/dist`);
}
