import { describe, expect, it, vi } from 'vitest';
import { createPairFundTarget } from '../src/targets/pairfund/index.js';
import { PAIR_LAUNCHPAD_V5 } from '../src/targets/pairfund/abi.js';
import { nullLogger } from '../src/log.js';

const LAUNCH_FEE = 500_000_000_000_000n; // 0.0005 ETH
const GAS = 3_000_000n;
const GAS_PRICE = 36_104_000n;

const STOCKS = [
	{ symbol: 'NVDA', address: '0xnvda', decimals: 18, enabled: true, launchedTokenCount: 17 },
	{ symbol: 'TSLA', address: '0xtsla', decimals: 18, enabled: true, launchedTokenCount: 10 },
	{ symbol: 'AAPL', address: '0xaapl', decimals: 18, enabled: true, launchedTokenCount: 30 },
];

const fakeApi = (over = {}) => ({
	baseUrl: 'https://pair.fund',
	stockTokens: vi.fn(async () => STOCKS),
	symbolTaken: vi.fn(async () => false),
	mirrorImage: vi.fn(async () => 'https://pair.fund/api/images/abc'),
	uploadMetadata: vi.fn(async () => ({ metadataURI: 'https://pair.fund/api/metadata/abc', metadataHash: `0x${'11'.repeat(32)}` })),
	registerLaunch: vi.fn(async () => '0xtoken0000000000000000000000000000000001'),
	health: vi.fn(async () => ({ status: 'ok' })),
	...over,
});

const fakeWallet = ({ publicClient = {}, ...over } = {}) => ({
	address: '0x1111111111111111111111111111111111111111',
	label: 'hd-0',
	signer: { address: '0x1111111111111111111111111111111111111111' },
	balance: async () => 10n ** 18n,
	client: { writeContract: vi.fn(async () => '0xtxhash') },
	...over,
	publicClient: {
		readContract: vi.fn(async () => LAUNCH_FEE),
		simulateContract: vi.fn(async () => ({ result: '0xTOKEN0000000000000000000000000000000001', request: {} })),
		estimateContractGas: vi.fn(async () => GAS),
		getGasPrice: vi.fn(async () => GAS_PRICE),
		waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', gasUsed: GAS })),
		...publicClient,
	},
});

const spec = (over = {}) => ({
	name: 'Poppy',
	symbol: 'POPPY',
	description: 'a seagull',
	imageUrl: 'https://ipfs.io/ipfs/x',
	links: { twitter: 'https://x.com/p', telegram: null, website: null },
	origin: { source: 'pumpfun-graduations', chain: 'solana', address: 'MINT1', url: null, signalId: 'pumpfun:MINT1' },
	targetHints: {},
	...over,
});

const ctx = (wallet) => ({ wallet, log: nullLogger });

describe('createPairFundTarget.plan', () => {
	it('builds a launch whose pool weights total 10000 bps', async () => {
		const target = createPairFundTarget({ api: fakeApi(), marketSelector: { strategy: 'popular', count: 2 } });
		const plan = await target.plan(spec(), ctx(fakeWallet()));
		const [params] = plan.call.args;
		expect(params.allocations.map((a) => a.quoteToken)).toEqual(['0xaapl', '0xnvda']);
		expect(params.allocations.reduce((sum, a) => sum + a.weightBps, 0)).toBe(10_000);
	});

	it('sends the contract-reported launch fee as the transaction value', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		const plan = await target.plan(spec(), ctx(fakeWallet()));
		expect(plan.call.value).toBe(LAUNCH_FEE);
		expect(plan.cost.feeNative).toBe('0.0005');
		expect(plan.contract).toBe(PAIR_LAUNCHPAD_V5);
	});

	it('prices gas with a buffer over the estimate', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		const plan = await target.plan(spec(), ctx(fakeWallet()));
		const bufferedGas = (GAS * 115n) / 100n;
		expect(plan.call.gas).toBe(bufferedGas);
		expect(plan.cost.totalBase).toBe(LAUNCH_FEE + bufferedGas * GAS_PRICE);
	});

	it('defaults creator fees to the launching wallet', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		const wallet = fakeWallet();
		const plan = await target.plan(spec(), ctx(wallet));
		expect(plan.call.args[0].creatorFeeRecipient).toBe(wallet.address);
	});

	it('honours an explicit creator fee recipient', async () => {
		const recipient = '0x9999999999999999999999999999999999999999';
		const target = createPairFundTarget({ api: fakeApi(), creatorFeeRecipient: recipient });
		const plan = await target.plan(spec(), ctx(fakeWallet()));
		expect(plan.call.args[0].creatorFeeRecipient).toBe(recipient);
	});

	it('sets a future deadline', async () => {
		const target = createPairFundTarget({ api: fakeApi(), deadlineSeconds: 300 });
		const plan = await target.plan(spec(), ctx(fakeWallet()));
		const now = BigInt(Math.floor(Date.now() / 1000));
		expect(plan.call.args[0].deadline).toBeGreaterThan(now);
		expect(plan.call.args[0].deadline).toBeLessThanOrEqual(now + 300n);
	});

	it('disables the developer buy by default', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		const params = (await target.plan(spec(), ctx(fakeWallet()))).call.args[0];
		expect(params.developerBuyRecipient).toBe('0x0000000000000000000000000000000000000000');
		expect(params.developerTokenAmountOut).toBe(0n);
		expect(params.maxQuoteAmountIn).toBe(0n);
	});

	it('rejects a developer buy with no spend ceiling', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		await expect(target.plan(spec({ targetHints: { devBuy: { tokenAmountOut: 1n } } }), ctx(fakeWallet())))
			.rejects.toThrow(/maxQuoteIn must be positive/);
	});

	it('rejects a developer buy pointed at a market it did not select', async () => {
		const target = createPairFundTarget({ api: fakeApi(), marketSelector: { strategy: 'popular', count: 1 } });
		const hints = { devBuy: { tokenAmountOut: 1n, maxQuoteIn: 1n, pairIndex: 3 } };
		await expect(target.plan(spec({ targetHints: hints }), ctx(fakeWallet())))
			.rejects.toThrow(/outside the 1 selected markets/);
	});

	it('warns instead of failing when the source artwork cannot be mirrored', async () => {
		const target = createPairFundTarget({ api: fakeApi({ mirrorImage: async () => null }) });
		const plan = await target.plan(spec(), ctx(fakeWallet()));
		expect(plan.warnings.join(' ')).toMatch(/could not be mirrored/);
	});

	it('refuses a live plan when simulation reverts', async () => {
		const wallet = fakeWallet({ publicClient: { simulateContract: async () => { throw new Error('execution reverted'); } } });
		const target = createPairFundTarget({ api: fakeApi() });
		await expect(target.plan(spec(), ctx(wallet))).rejects.toThrow(/simulation failed/);
	});

	it('uploads nothing during a dry run', async () => {
		const api = fakeApi();
		const target = createPairFundTarget({ api });
		const plan = await target.plan(spec(), { ...ctx(fakeWallet()), dryRun: true });
		expect(api.uploadMetadata).not.toHaveBeenCalled();
		expect(api.mirrorImage).not.toHaveBeenCalled();
		expect(plan.dryRun).toBe(true);
		expect(plan.call.args[0].metadataHash).toMatch(/^0x[0-9a-f]{64}$/);
	});
});

describe('createPairFundTarget.execute', () => {
	it('refuses to send a dry-run plan', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		const wallet = fakeWallet();
		const plan = await target.plan(spec(), { ...ctx(wallet), dryRun: true });
		await expect(target.execute(plan, ctx(wallet))).rejects.toThrow(/cannot execute a dry-run plan/);
	});

	it('refuses a plan priced for another wallet', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		const plan = await target.plan(spec(), ctx(fakeWallet()));
		const other = fakeWallet({ address: '0x2222222222222222222222222222222222222222' });
		await expect(target.execute(plan, ctx(other))).rejects.toThrow(/priced for/);
	});

	it('refuses a plan whose deadline has passed', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		const wallet = fakeWallet();
		const plan = await target.plan(spec(), ctx(wallet));
		plan.call.deadline = BigInt(Math.floor(Date.now() / 1000) - 1);
		await expect(target.execute(plan, ctx(wallet))).rejects.toThrow(/deadline has passed/);
	});

	it('returns the indexer-resolved token address on success', async () => {
		const target = createPairFundTarget({ api: fakeApi() });
		const wallet = fakeWallet();
		const plan = await target.plan(spec(), ctx(wallet));
		const result = await target.execute(plan, ctx(wallet));
		expect(result).toMatchObject({
			ok: true,
			txHash: '0xtxhash',
			tokenAddress: '0xtoken0000000000000000000000000000000001',
			url: 'https://pair.fund/tokens/0xtoken0000000000000000000000000000000001',
		});
	});

	it('falls back to the simulated address when the indexer is unavailable', async () => {
		const target = createPairFundTarget({ api: fakeApi({ registerLaunch: async () => null }) });
		const wallet = fakeWallet();
		const plan = await target.plan(spec(), ctx(wallet));
		const result = await target.execute(plan, ctx(wallet));
		expect(result.tokenAddress).toBe('0xtoken0000000000000000000000000000000001');
	});

	it('reports a reverted transaction as a failure, not a launch', async () => {
		const wallet = fakeWallet({
			publicClient: { waitForTransactionReceipt: async () => ({ status: 'reverted' }) },
		});
		const target = createPairFundTarget({ api: fakeApi() });
		const plan = await target.plan(spec(), ctx(wallet));
		const result = await target.execute(plan, ctx(wallet));
		expect(result).toMatchObject({ ok: false, error: 'transaction reverted on chain' });
	});
});
