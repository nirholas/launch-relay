import { describe, expect, it, vi } from 'vitest';
import { executeClaims, fetchClaimable, fetchPending, planClaims } from '../src/targets/pairfund/fees.js';
import { PAIR_V4_LOCKER } from '../src/targets/pairfund/abi.js';
import { nullLogger } from '../src/log.js';

const row = (over = {}) => ({
	quoteToken: { address: '0xdoge', symbol: 'DOGE', decimals: 18 },
	claimableAmount: '2107495294454829999999',
	claimableAmountUsd: null,
	lockerAddress: '0xefcf476e8870fb3eb8680f039414fdcce6c2a117',
	assetType: 'PROJECT',
	claimAssetAddress: '0xdoge',
	...over,
});

const api = (rows) => ({ feesClaimable: async () => rows, feesPending: async () => [] });

const wallet = (over = {}) => ({
	address: '0x1111111111111111111111111111111111111111',
	label: 'hd-0',
	signer: {},
	publicClient: {
		getGasPrice: async () => 40_000_000n,
		estimateContractGas: vi.fn(async () => 100_000n),
		simulateContract: vi.fn(async () => ({ request: {} })),
		waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
		...over.publicClient,
	},
	client: { writeContract: vi.fn(async () => '0xclaimtx') },
});

describe('fetchClaimable', () => {
	it('normalizes amounts and keeps the locker the API named', async () => {
		const [fee] = await fetchClaimable(api([row()]), '0xwallet');
		expect(fee.symbol).toBe('DOGE');
		expect(fee.amount).toBe(2107495294454829999999n);
		expect(fee.amountFormatted).toBe('2107.495294454829999999');
		expect(fee.lockerAddress).toBe('0xefcf476e8870fb3eb8680f039414fdcce6c2a117');
	});

	it('drops zero balances so no gas is burned claiming nothing', async () => {
		const rows = await fetchClaimable(api([row({ claimableAmount: '0' }), row()]), '0xwallet');
		expect(rows).toHaveLength(1);
	});

	it('drops rows with no asset to claim against', async () => {
		const rows = await fetchClaimable(api([row({ claimAssetAddress: null, quoteToken: { symbol: 'X', decimals: 18 } })]), '0xw');
		expect(rows).toHaveLength(0);
	});

	it('falls back to the pinned locker when the API omits one', async () => {
		const [fee] = await fetchClaimable(api([row({ lockerAddress: null })]), '0xw');
		expect(fee.lockerAddress).toBe(PAIR_V4_LOCKER);
	});

	it('survives a non-array response', async () => {
		expect(await fetchClaimable({ feesClaimable: async () => null }, '0xw')).toEqual([]);
	});
});

describe('fetchPending', () => {
	it('reports pending fees separately from claimable ones', async () => {
		const rows = await fetchPending(
			{ feesPending: async () => [{ quoteToken: { symbol: 'AAPL', decimals: 18 }, pendingAmount: '5' }] },
			'0xw',
		);
		expect(rows[0]).toMatchObject({ symbol: 'AAPL', amount: 5n });
	});
});

describe('planClaims', () => {
	it('prices one transaction per asset with a gas buffer', async () => {
		const rows = await fetchClaimable(api([row(), row({ quoteToken: { address: '0xaapl', symbol: 'AAPL', decimals: 18 }, claimAssetAddress: '0xaapl' })]), '0xw');
		const plan = await planClaims({ rows, wallet: wallet() });
		expect(plan.claims).toHaveLength(2);
		expect(plan.claims[0].gas).toBe(120_000n);
		expect(plan.totalGas).toBe(240_000n);
		expect(plan.summary.join(' ')).toMatch(/2 asset\(s\)/);
	});

	it('keeps a claim that will not simulate, flagged rather than dropped', async () => {
		const w = wallet({ publicClient: { estimateContractGas: async () => { throw new Error('reverted'); } } });
		const rows = await fetchClaimable(api([row()]), '0xw');
		const plan = await planClaims({ rows, wallet: w });
		expect(plan.claims[0].simulated).toBe(false);
		expect(plan.claims).toHaveLength(1);
	});
});

describe('executeClaims', () => {
	it('reports each claim result', async () => {
		const rows = await fetchClaimable(api([row()]), '0xw');
		const w = wallet();
		const plan = await planClaims({ rows, wallet: w });
		const results = await executeClaims({ claims: plan.claims, wallet: w, chain: {}, log: nullLogger });
		expect(results[0]).toMatchObject({ ok: true, symbol: 'DOGE', txHash: '0xclaimtx' });
	});

	it('keeps going after one asset fails', async () => {
		const rows = await fetchClaimable(api([
			row(),
			row({ quoteToken: { address: '0xaapl', symbol: 'AAPL', decimals: 18 }, claimAssetAddress: '0xaapl' }),
		]), '0xw');
		const w = wallet();
		let call = 0;
		w.publicClient.simulateContract = vi.fn(async () => {
			call++;
			if (call === 1) throw new Error('balance moved');
			return { request: {} };
		});
		const plan = await planClaims({ rows, wallet: w });
		const results = await executeClaims({ claims: plan.claims, wallet: w, chain: {}, log: nullLogger });
		expect(results.map((r) => r.ok)).toEqual([false, true]);
	});

	it('records a reverted claim as failed rather than claimed', async () => {
		const rows = await fetchClaimable(api([row()]), '0xw');
		const w = wallet({ publicClient: { waitForTransactionReceipt: async () => ({ status: 'reverted' }) } });
		const plan = await planClaims({ rows, wallet: w });
		const [result] = await executeClaims({ claims: plan.claims, wallet: w, chain: {}, log: nullLogger });
		expect(result.ok).toBe(false);
	});
});
