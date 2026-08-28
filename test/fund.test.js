import { describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import { executeFunding, planFunding } from '../src/wallets/fund.js';
import { nullLogger } from '../src/log.js';

const pool = (balances) => {
	const handles = balances.map((wei, i) => ({
		address: `0x${String(i + 1).repeat(40).slice(0, 40)}`,
		label: `hd-${i}`,
		signer: {},
		balance: async () => wei,
		client: { sendTransaction: vi.fn(async () => `0xtx${i}`) },
		publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })) },
	}));
	return { chain: 'test', list: () => handles, pick: async () => handles[0], markUsed() {}, handles };
};

describe('planFunding', () => {
	it('levels every wallet up to the target from the richest one', async () => {
		const wallets = pool([parseEther('1'), 0n, parseEther('0.001')]);
		const plan = await planFunding({ wallets, target: '0.01' });
		expect(plan.from.label).toBe('hd-0');
		expect(plan.transfers.map((t) => t.label)).toEqual(['hd-1', 'hd-2']);
		expect(plan.transfers[0].amount).toBe(parseEther('0.01'));
		expect(plan.transfers[1].amount).toBe(parseEther('0.009'));
		expect(plan.totalWei).toBe(parseEther('0.019'));
	});

	it('skips wallets already at the target', async () => {
		const wallets = pool([parseEther('1'), parseEther('0.05'), 0n]);
		const plan = await planFunding({ wallets, target: '0.01' });
		expect(plan.transfers.map((t) => t.label)).toEqual(['hd-2']);
	});

	it('reports a shortfall instead of planning a transfer that cannot settle', async () => {
		const wallets = pool([parseEther('0.005'), 0n, 0n]);
		const plan = await planFunding({ wallets, target: '0.01', reserve: '0.001' });
		expect(plan.shortfallWei).toBeGreaterThan(0n);
		expect(plan.summary.join(' ')).toMatch(/SHORTFALL/);
	});

	it('keeps a gas reserve in the source wallet', async () => {
		const wallets = pool([parseEther('0.0105'), 0n]);
		const plan = await planFunding({ wallets, target: '0.01', reserve: '0.001' });
		expect(plan.shortfallWei).toBe(parseEther('0.0005'));
	});

	it('honours an explicit source wallet', async () => {
		const wallets = pool([parseEther('0.001'), parseEther('5')]);
		const plan = await planFunding({ wallets, target: '0.01', from: wallets.handles[1].address });
		expect(plan.from.label).toBe('hd-1');
		expect(plan.transfers[0].label).toBe('hd-0');
	});

	it('refuses an unknown source wallet', async () => {
		const wallets = pool([parseEther('1'), 0n]);
		await expect(planFunding({ wallets, target: '0.01', from: '0xdead' })).rejects.toThrow(/not in the pool/);
	});

	it('refuses a pool of one', async () => {
		await expect(planFunding({ wallets: pool([parseEther('1')]), target: '0.01' }))
			.rejects.toThrow(/at least two wallets/);
	});
});

describe('executeFunding', () => {
	it('sends every transfer from the source wallet', async () => {
		const wallets = pool([parseEther('1'), 0n, 0n]);
		const plan = await planFunding({ wallets, target: '0.01' });
		const results = await executeFunding({ plan, wallets, chain: {}, log: nullLogger });
		expect(results).toHaveLength(2);
		expect(wallets.handles[0].client.sendTransaction).toHaveBeenCalledTimes(2);
	});

	it('refuses to start when the plan is short', async () => {
		const wallets = pool([parseEther('0.002'), 0n, 0n]);
		const plan = await planFunding({ wallets, target: '0.01' });
		await expect(executeFunding({ plan, wallets, chain: {}, log: nullLogger })).rejects.toThrow(/short by/);
	});

	it('stops on the first reverted transfer', async () => {
		const wallets = pool([parseEther('1'), 0n, 0n]);
		wallets.handles[0].publicClient.waitForTransactionReceipt = vi.fn(async () => ({ status: 'reverted' }));
		const plan = await planFunding({ wallets, target: '0.01' });
		await expect(executeFunding({ plan, wallets, chain: {}, log: nullLogger })).rejects.toThrow(/reverted/);
		expect(wallets.handles[0].client.sendTransaction).toHaveBeenCalledTimes(1);
	});
});
