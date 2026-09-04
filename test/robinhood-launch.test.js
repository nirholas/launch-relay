import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, getAddress, isAddress } from 'viem';
import artifact from '../src/chains/robinhood/artifacts/launch-token.json' with { type: 'json' };
import { AMMS, AMM_FORKS, DECIMALS, INFRA, TOKENS } from '../src/chains/robinhood/contracts.js';
import { ROBINHOOD_CHAIN_ID, robinhoodChain, tokenUrl, txUrl } from '../src/chains/robinhood/chain.js';
import { buildDescriptorDocument, fixedMetadataHost, inlineMetadataHost } from '../src/chains/robinhood/metadata.js';
import { createPoolLaunchTarget, encodeDeploy } from '../src/chains/robinhood/amm/pool-target.js';
import { mintedToken } from '../src/chains/robinhood/target.js';

const spec = {
	name: 'Loop Rat',
	symbol: 'LOOPRAT',
	description: 'an agent that keeps going',
	imageUrl: 'https://cdn.example/rat.png',
	links: { twitter: 'https://x.com/looprat', telegram: null, website: null },
	origin: { source: 'manual', chain: 'solana', signalId: 'test' },
};

describe('the address book', () => {
	it('holds checksummed addresses only', () => {
		const all = [...Object.values(TOKENS), ...Object.values(INFRA), ...AMM_FORKS.v2, ...AMM_FORKS.v3];
		for (const amm of Object.values(AMMS)) {
			for (const value of Object.values(amm)) if (typeof value === 'string' && value.startsWith('0x')) all.push(value);
		}
		for (const address of all) {
			expect(isAddress(address), `${address} is not an address`).toBe(true);
			expect(getAddress(address), `${address} is not checksummed`).toBe(address);
		}
	});

	it('records that USDG is not an 18 decimal token', () => {
		expect(DECIMALS[TOKENS.USDG.toLowerCase()]).toBe(6);
		expect(DECIMALS[TOKENS.WETH.toLowerCase()]).toBe(18);
	});

	it('lists the canonical factory first among its forks', () => {
		expect(AMM_FORKS.v2[0]).toBe(AMMS['uniswap-v2'].factory);
		expect(AMM_FORKS.v3[0]).toBe(AMMS['uniswap-v3'].factory);
	});

	it('names the chain the explorer links point at', () => {
		expect(robinhoodChain().id).toBe(ROBINHOOD_CHAIN_ID);
		expect(txUrl('0xabc')).toContain('/tx/0xabc');
		expect(tokenUrl('0xabc')).toContain('/token/0xabc');
	});
});

describe('the launch token artifact', () => {
	it('is compiled, fixed supply, and has no owner', () => {
		expect(artifact.bytecode.startsWith('0x')).toBe(true);
		expect(artifact.bytecode.length).toBeGreaterThan(1000);
		const fns = artifact.abi.filter((e) => e.type === 'function').map((e) => e.name);
		expect(fns).toContain('transfer');
		expect(fns).toContain('approve');
		expect(fns).not.toContain('mint');
		expect(fns).not.toContain('owner');
		expect(fns).not.toContain('transferOwnership');
	});

	it('encodes constructor arguments onto the creation code', () => {
		const data = encodeDeploy({ spec, decimals: 18, supply: 10n ** 27n, metadataURI: 'ipfs://x', mintTo: TOKENS.WETH });
		expect(data.startsWith(artifact.bytecode)).toBe(true);
		const inputs = artifact.abi.find((e) => e.type === 'constructor').inputs;
		const decoded = decodeAbiParameters(inputs, `0x${data.slice(artifact.bytecode.length)}`);
		expect(decoded[0]).toBe('Loop Rat');
		expect(decoded[1]).toBe('LOOPRAT');
		expect(decoded[3]).toBe(10n ** 27n);
		expect(decoded[5]).toBe(getAddress(TOKENS.WETH));
	});
});

describe('metadata hosts', () => {
	it('builds the descriptor every venue frontend reads', () => {
		expect(buildDescriptorDocument(spec)).toEqual({
			name: 'Loop Rat',
			symbol: 'LOOPRAT',
			description: 'an agent that keeps going',
			image: 'https://cdn.example/rat.png',
			twitter: 'https://x.com/looprat',
		});
	});

	it('inlines the document into the URI', async () => {
		const { metadataURI, metadataHash } = await inlineMetadataHost().publish(spec);
		expect(metadataURI.startsWith('data:application/json;base64,')).toBe(true);
		const json = JSON.parse(Buffer.from(metadataURI.split(',')[1], 'base64').toString('utf8'));
		expect(json.symbol).toBe('LOOPRAT');
		expect(metadataHash).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it('refuses rather than truncates when the document will not fit', async () => {
		const host = inlineMetadataHost({ maxBytes: 64 });
		await expect(host.publish(spec)).rejects.toThrow(/over the 64 byte limit/);
	});

	it('passes a caller-supplied URI straight through', async () => {
		const published = await fixedMetadataHost('ipfs://bafkreiabc').publish(spec);
		expect(published.metadataURI).toBe('ipfs://bafkreiabc');
	});

	it('will not be constructed without a URI', () => {
		expect(() => fixedMetadataHost('')).toThrow(/needs a URI/);
	});
});

describe('finding the launched token in a receipt', () => {
	const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
	const ZERO = `0x${'0'.repeat(64)}`;

	it('picks the ERC-20 minted from the zero address', () => {
		const receipt = { logs: [
			{ address: '0x1111111111111111111111111111111111111111', topics: [TRANSFER, ZERO, ZERO, ZERO], data: '0x' },
			{ address: '0x2222222222222222222222222222222222222222', topics: [TRANSFER, ZERO, ZERO], data: '0x0a' },
		] };
		expect(mintedToken(receipt)).toBe('0x2222222222222222222222222222222222222222');
	});

	it('returns null when the receipt minted nothing', () => {
		expect(mintedToken({ logs: [] })).toBeNull();
	});
});

describe('pool launch configuration', () => {
	it('defaults to a single-sided V3 pool quoted in WETH', () => {
		const target = createPoolLaunchTarget();
		expect(target.id).toBe('pool:uniswap-v3');
		expect(target.poolType).toBe('single-sided');
		expect(target.quote.symbol).toBe('WETH');
		expect(target.chainId).toBe(ROBINHOOD_CHAIN_ID);
	});

	it('refuses a one-sided constant-product pool, which cannot exist', () => {
		expect(() => createPoolLaunchTarget({ amm: 'uniswap-v2', poolType: 'single-sided' }))
			.toThrow(/cannot be one-sided/);
	});

	it('refuses native ETH on V3, which only knows WETH', () => {
		expect(() => createPoolLaunchTarget({ amm: 'uniswap-v3', quote: 'ETH' })).toThrow(/quote in WETH/);
	});

	it('takes native ETH on V4, which addresses it as the zero address', () => {
		const target = createPoolLaunchTarget({ amm: 'uniswap-v4', quote: 'ETH' });
		expect(target.quote.native).toBe(true);
		expect(target.quote.address).toBe(`0x${'0'.repeat(40)}`);
	});

	it('accepts any ERC-20 as a quote, including a tokenized stock', () => {
		const target = createPoolLaunchTarget({ quote: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' });
		expect(target.quote.address).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
	});

	it('rejects an AMM it does not implement', () => {
		expect(() => createPoolLaunchTarget({ amm: 'curve' })).toThrow(/unknown AMM/);
	});

	it('rejects a quote it cannot resolve', () => {
		expect(() => createPoolLaunchTarget({ quote: 'DOGE' })).toThrow(/unknown quote/);
	});

	it('rejects a supply share outside its bounds', () => {
		expect(() => createPoolLaunchTarget({ supplyInPoolPct: 0 })).toThrow(/between 0 and 100/);
		expect(() => createPoolLaunchTarget({ supplyInPoolPct: 101 })).toThrow(/between 0 and 100/);
	});

	it('can be pointed at a fork by swapping the factory', () => {
		const target = createPoolLaunchTarget({ amm: 'uniswap-v3', factory: AMM_FORKS.v3[1] });
		expect(target.amm.factory).toBe(AMM_FORKS.v3[1]);
	});
});

describe('the documentation and the address book agree', () => {
	// Docs go stale silently and an address in prose is exactly as dangerous as
	// one in code: somebody will copy it. Every address printed in the chain
	// reference has to be one this toolkit actually uses, spelled the same way.
	it('every address in docs/robinhood-chain.md is one the code pins', async () => {
		const { readFile } = await import('node:fs/promises');
		const { AMMS, AMM_FORKS, INFRA, TOKENS } = await import('../src/chains/robinhood/contracts.js');
		const pinned = new Set([
			...Object.values(TOKENS), ...Object.values(INFRA), ...AMM_FORKS.v2, ...AMM_FORKS.v3,
			...Object.values(AMMS).flatMap((amm) => Object.values(amm).filter((v) => typeof v === 'string' && v.startsWith('0x'))),
		]);
		const doc = await readFile(new URL('../docs/robinhood-chain.md', import.meta.url), 'utf8');
		for (const address of doc.match(/0x[0-9a-fA-F]{40}/g) || []) {
			expect(pinned.has(address), `${address} in docs/robinhood-chain.md is not pinned in contracts.js`).toBe(true);
		}
	});
});
