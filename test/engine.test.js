import { describe, expect, it, vi } from 'vitest';
import { createRelay } from '../src/engine.js';
import { createMemoryStore } from '../src/store/memory.js';
import { createManualSource } from '../src/sources/manual.js';
import { nullLogger } from '../src/log.js';

const COST = 1_000_000_000_000_000n; // 0.001 ETH

function fakeWalletPool({ balance = 10n ** 18n } = {}) {
	const handle = {
		address: '0x1111111111111111111111111111111111111111',
		label: 'test-0',
		signer: {},
		balance: async () => balance,
	};
	return {
		chain: 'test',
		list: () => [handle],
		pick: vi.fn(async () => handle),
		markUsed: vi.fn(),
		handle,
	};
}

function fakeTarget({ takenSymbols = [], executeResult, planCost = COST } = {}) {
	const taken = new Set(takenSymbols);
	return {
		id: 'faketarget',
		chain: 'testchain',
		chainId: 1,
		nativeSymbol: 'ETH',
		nativeDecimals: 18,
		symbolTaken: vi.fn(async (s) => taken.has(s)),
		plan: vi.fn(async (spec, { wallet, dryRun }) => ({
			target: 'faketarget',
			chain: 'testchain',
			chainId: 1,
			spec,
			wallet: wallet.address,
			contract: '0xcontract',
			cost: { nativeSymbol: 'ETH', feeNative: '0.001', gasNative: '0', totalNative: '0.001', totalBase: planCost },
			warnings: [],
			dryRun,
			call: {},
			summary: [`token ${spec.symbol}`],
		})),
		execute: vi.fn(async () => executeResult || {
			ok: true, txHash: '0xtx', tokenAddress: '0xtoken', url: 'https://example.com/t',
		}),
	};
}

const signal = (over = {}) => ({
	id: 'manual:one',
	source: 'manual',
	kind: 'manual',
	chain: 'test',
	at: Date.now(),
	address: 'MINT1',
	name: 'Test Coin',
	symbol: 'TEST',
	description: 'a coin',
	imageUrl: 'https://example.com/i.png',
	links: {},
	metrics: { marketCapUsd: 50_000 },
	...over,
});

const relayWith = (over = {}) => {
	const target = over.target || fakeTarget();
	const wallets = over.wallets || fakeWalletPool();
	const store = over.store || createMemoryStore();
	const relay = createRelay({
		sources: [createManualSource([])],
		target,
		wallets,
		store,
		logger: nullLogger,
		rules: { kinds: ['manual'], maxSignalAgeSeconds: null, ...over.rules },
		budget: over.budget,
		mode: over.mode || 'dry-run',
		confirm: over.confirm,
		...(over.mapper ? { mapper: over.mapper } : {}),
	});
	return { relay, target, wallets, store };
};

describe('createRelay', () => {
	it('refuses to build in live mode without a confirm callback', () => {
		expect(() => relayWith({ mode: 'live' })).toThrow(/requires a confirm callback/);
	});

	it('plans but never executes in dry-run mode', async () => {
		const { relay, target, store } = relayWith();
		const out = await relay.handleSignal(signal());
		expect(out.status).toBe('planned');
		expect(target.plan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: true }));
		expect(target.execute).not.toHaveBeenCalled();
		const [record] = await store.history();
		expect(record.status).toBe('planned');
	});

	it('executes once confirmation is granted', async () => {
		const confirm = vi.fn(async () => true);
		const { relay, target, wallets, store } = relayWith({ mode: 'live', confirm });
		const out = await relay.handleSignal(signal());
		expect(out.status).toBe('launched');
		expect(confirm).toHaveBeenCalledOnce();
		expect(target.execute).toHaveBeenCalledOnce();
		expect(wallets.markUsed).toHaveBeenCalledWith(wallets.handle.address);
		expect((await store.history())[0]).toMatchObject({ status: 'launched', txHash: '0xtx', tokenAddress: '0xtoken' });
	});

	it('does not execute when confirmation is declined', async () => {
		const { relay, target, store } = relayWith({ mode: 'live', confirm: async () => false });
		const out = await relay.handleSignal(signal());
		expect(out.status).toBe('skipped');
		expect(target.execute).not.toHaveBeenCalled();
		expect((await store.history())[0].status).toBe('declined');
	});

	it('processes a signal exactly once', async () => {
		const { relay, target } = relayWith();
		await relay.handleSignal(signal());
		const second = await relay.handleSignal(signal());
		expect(second).toMatchObject({ status: 'skipped', reason: 'duplicate' });
		expect(target.plan).toHaveBeenCalledOnce();
	});

	it('rejects a filtered signal before doing any work', async () => {
		const { relay, target } = relayWith({ rules: { minMarketCapUsd: 1e9 } });
		const out = await relay.handleSignal(signal());
		expect(out).toMatchObject({ status: 'skipped', reason: 'filtered' });
		expect(target.plan).not.toHaveBeenCalled();
	});

	it('resolves a ticker collision before planning', async () => {
		const target = fakeTarget({ takenSymbols: ['TEST'] });
		const { relay } = relayWith({ target });
		await relay.handleSignal(signal());
		expect(target.plan.mock.calls[0][0].symbol).toBe('TEST2');
	});

	it('gives up when every ticker variant is taken', async () => {
		const target = {
			...fakeTarget(),
			symbolTaken: async () => true,
		};
		const { relay } = relayWith({ target });
		const out = await relay.handleSignal(signal());
		expect(out).toMatchObject({ status: 'skipped', reason: 'symbol-exhausted' });
	});

	it('launches anyway when the collision check itself fails', async () => {
		const target = fakeTarget();
		target.symbolTaken = async () => { throw new Error('api down'); };
		const { relay } = relayWith({ target, mode: 'live', confirm: async () => true });
		const out = await relay.handleSignal(signal());
		expect(out.status).toBe('launched');
	});

	it('leaves a budget-stopped signal unmarked so it can pass later', async () => {
		const { relay, store } = relayWith({
			mode: 'live',
			confirm: async () => true,
			budget: { maxSpendPerLaunch: '0.0000001' },
		});
		const out = await relay.handleSignal(signal());
		expect(out).toMatchObject({ status: 'skipped', reason: 'budget' });
		expect(await store.seen('manual:one')).toBe(false);
	});

	it('does not spend when no wallet can cover the reserve', async () => {
		const wallets = fakeWalletPool();
		wallets.pick = vi.fn(async () => null);
		const { relay, target } = relayWith({ wallets, mode: 'live', confirm: async () => true });
		const out = await relay.handleSignal(signal());
		expect(out).toMatchObject({ status: 'retry', reason: 'no-wallet' });
		expect(target.plan).not.toHaveBeenCalled();
	});

	it('still prices a dry run when no wallet could pay for it', async () => {
		const wallets = fakeWalletPool();
		wallets.pick = vi.fn(async () => null);
		const { relay, target } = relayWith({ wallets });
		const out = await relay.handleSignal(signal());
		expect(out.status).toBe('planned');
		expect(target.plan).toHaveBeenCalledOnce();
		expect(out.plan.warnings.join(' ')).toMatch(/no wallet in the pool could fund/);
	});

	it('reports a dry run the budget would have stopped instead of hiding it', async () => {
		const { relay, store } = relayWith({ budget: { maxSpendPerLaunch: '0.0000001' } });
		const out = await relay.handleSignal(signal());
		expect(out.status).toBe('planned');
		expect(out.budgetBlock).toMatch(/per-launch cap/);
		expect((await store.history())[0].budgetBlock).toMatch(/per-launch cap/);
	});

	it('refuses to plan at all when the pool holds no wallets', async () => {
		const wallets = fakeWalletPool();
		wallets.pick = vi.fn(async () => null);
		wallets.list = () => [];
		const { relay } = relayWith({ wallets });
		expect(await relay.handleSignal(signal())).toMatchObject({ status: 'skipped', reason: 'no-wallet' });
	});

	it('retries a transient planning failure and then gives up', async () => {
		const target = fakeTarget();
		target.plan = vi.fn(async () => { throw new Error('rpc down'); });
		const { relay } = relayWith({ target });
		expect((await relay.handleSignal(signal())).status).toBe('retry');
		expect((await relay.handleSignal(signal())).status).toBe('retry');
		const third = await relay.handleSignal(signal());
		expect(third).toMatchObject({ status: 'skipped', reason: 'plan-failed-giving-up' });
	});

	it('records a failed execution without claiming success', async () => {
		const target = fakeTarget({ executeResult: { ok: false, txHash: '0xtx', error: 'reverted' } });
		const { relay, store } = relayWith({ target, mode: 'live', confirm: async () => true });
		const out = await relay.handleSignal(signal());
		expect(out.status).toBe('failed');
		expect((await store.history())[0]).toMatchObject({ status: 'failed', error: 'reverted' });
	});

	it('drains every source in runOnce', async () => {
		const target = fakeTarget();
		const relay = createRelay({
			sources: [createManualSource([{ id: 'a', symbol: 'AAA', name: 'Coin A', imageUrl: 'https://x/i.png' }])],
			target,
			wallets: fakeWalletPool(),
			store: createMemoryStore(),
			logger: nullLogger,
			rules: { kinds: ['manual'], maxSignalAgeSeconds: null },
		});
		const history = await relay.runOnce();
		expect(history).toHaveLength(1);
		expect(history[0].symbol).toBe('AAA');
	});
});
