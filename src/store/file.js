// Append-only JSONL store. Two files under one directory:
//
//   seen.jsonl     one {key, at} per deduped signal
//   launches.jsonl one record per planned, skipped, or executed launch
//
// JSONL because the ledger is the audit trail for money that moved: appends
// are atomic enough at these sizes, a truncated final line costs one record
// rather than the file, and `tail -f` is a working live view. The seen set is
// read into memory once at open and appended to from then on.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * @param {string} dir Directory holding the ledger files. Created if missing.
 * @returns {Promise<import('../types.js').Store>}
 */
export async function createFileStore(dir) {
	await mkdir(dir, { recursive: true });
	const seenPath = join(dir, 'seen.jsonl');
	const launchesPath = join(dir, 'launches.jsonl');
	const seen = new Set(
		(await readJsonl(seenPath)).map((r) => r.key).filter(Boolean),
	);

	return {
		async seen(key) { return seen.has(key); },
		async mark(key) {
			if (seen.has(key)) return;
			seen.add(key);
			await append(seenPath, { key, at: Date.now() });
		},
		async record(record) {
			await append(launchesPath, { at: Date.now(), ...record });
		},
		async history({ since = 0 } = {}) {
			const rows = await readJsonl(launchesPath);
			return rows.filter((r) => (r.at ?? 0) >= since);
		},
		paths: { dir, seen: seenPath, launches: launchesPath },
	};
}

async function append(path, obj) {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(obj, bigintSafe)}\n`, 'utf8');
}

const bigintSafe = (_k, v) => (typeof v === 'bigint' ? `${v}` : v);

async function readJsonl(path) {
	let text;
	try {
		text = await readFile(path, 'utf8');
	} catch (err) {
		if (err?.code === 'ENOENT') return [];
		throw err;
	}
	const out = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try { out.push(JSON.parse(trimmed)); } catch { continue; }
	}
	return out;
}
