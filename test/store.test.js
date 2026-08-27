import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileStore } from '../src/store/file.js';
import { createMemoryStore } from '../src/store/memory.js';

const dirs = [];
const tempDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'launch-relay-'));
	dirs.push(dir);
	return dir;
};

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('createMemoryStore', () => {
	it('tracks seen keys and records', async () => {
		const store = createMemoryStore();
		expect(await store.seen('a')).toBe(false);
		await store.mark('a');
		expect(await store.seen('a')).toBe(true);
		await store.record({ status: 'launched' });
		expect(await store.history()).toHaveLength(1);
	});
});

describe('createFileStore', () => {
	it('remembers seen keys across a restart', async () => {
		const dir = await tempDir();
		const first = await createFileStore(dir);
		await first.mark('pumpfun:MINT1');

		const second = await createFileStore(dir);
		expect(await second.seen('pumpfun:MINT1')).toBe(true);
		expect(await second.seen('pumpfun:MINT2')).toBe(false);
	});

	it('appends records that survive a restart', async () => {
		const dir = await tempDir();
		const first = await createFileStore(dir);
		await first.record({ status: 'launched', symbol: 'AAA' });
		await first.record({ status: 'planned', symbol: 'BBB' });

		const second = await createFileStore(dir);
		const history = await second.history();
		expect(history.map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
		expect(history[0].at).toBeTypeOf('number');
	});

	it('filters history by time', async () => {
		const dir = await tempDir();
		const store = await createFileStore(dir);
		await store.record({ status: 'launched', at: 1_000 });
		await store.record({ status: 'launched', at: 9_000 });
		expect(await store.history({ since: 5_000 })).toHaveLength(1);
	});

	it('serializes bigints rather than throwing on them', async () => {
		const dir = await tempDir();
		const store = await createFileStore(dir);
		await store.record({ status: 'launched', costBase: 12345n });
		expect((await store.history())[0].costBase).toBe('12345');
	});

	it('survives a truncated final line, losing only that record', async () => {
		const dir = await tempDir();
		const store = await createFileStore(dir);
		await store.record({ status: 'launched', symbol: 'AAA' });
		await writeFile(store.paths.launches, '{"status":"launched","symbol":"BB', { flag: 'a' });
		const reopened = await createFileStore(dir);
		expect((await reopened.history()).map((r) => r.symbol)).toEqual(['AAA']);
	});

	it('marks a key only once', async () => {
		const dir = await tempDir();
		const store = await createFileStore(dir);
		await store.mark('x');
		await store.mark('x');
		const reopened = await createFileStore(dir);
		expect(await reopened.seen('x')).toBe(true);
	});
});
