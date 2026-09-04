import { describe, expect, it } from 'vitest';
import {
	MAX_TICK, MIN_TICK, alignTick, bigIntSqrt, decodeSqrtPriceX96, encodeSqrtPriceX96, fullRange,
	liquidityForAmount0, liquidityForAmount1, liquidityForAmounts, priceToTick, singleSidedRange,
	sortTokens, sqrtPriceX96AtTick, tickToPrice,
} from '../src/chains/robinhood/amm/pool-math.js';

const Q96 = 2n ** 96n;

describe('integer square root', () => {
	it('is exact on perfect squares', () => {
		expect(bigIntSqrt(0n)).toBe(0n);
		expect(bigIntSqrt(1n)).toBe(1n);
		expect(bigIntSqrt((10n ** 30n) ** 2n)).toBe(10n ** 30n);
	});

	it('rounds down', () => {
		expect(bigIntSqrt(15n)).toBe(3n);
		expect(bigIntSqrt(16n)).toBe(4n);
	});

	it('refuses a negative', () => {
		expect(() => bigIntSqrt(-1n)).toThrow(/negative/);
	});
});

describe('sqrt price encoding', () => {
	it('gives exactly 2^96 at parity', () => {
		expect(encodeSqrtPriceX96(10n ** 18n, 10n ** 18n)).toBe(Q96);
	});

	it('doubles the sqrt price when the ratio quadruples', () => {
		expect(encodeSqrtPriceX96(4n * 10n ** 18n, 10n ** 18n)).toBe(2n * Q96);
	});

	it('handles a quote with fewer decimals', () => {
		// 1 token (18 decimals) priced at 2 USDG (6 decimals).
		const sqrtPrice = encodeSqrtPriceX96(2n * 10n ** 6n, 10n ** 18n);
		expect(decodeSqrtPriceX96(sqrtPrice)).toBeCloseTo(2e-12, 18);
	});

	it('refuses a zero side', () => {
		expect(() => encodeSqrtPriceX96(1n, 0n)).toThrow(/token0/);
		expect(() => encodeSqrtPriceX96(0n, 1n)).toThrow(/token1/);
	});
});

describe('ticks', () => {
	it('round trips through price at the origin', () => {
		expect(priceToTick(1)).toBe(0);
		expect(tickToPrice(0)).toBe(1);
	});

	it('moves one tick per 1.0001 of price', () => {
		expect(priceToTick(1.0001)).toBe(1);
		expect(tickToPrice(1)).toBeCloseTo(1.0001, 9);
	});

	it('clamps to what the AMM can address', () => {
		expect(priceToTick(1e300)).toBe(MAX_TICK);
		expect(priceToTick(1e-300)).toBe(MIN_TICK);
	});

	it('snaps onto a spacing and stays in range', () => {
		expect(alignTick(61, 60)).toBe(60);
		expect(alignTick(61, 60, 'up')).toBe(120);
		expect(alignTick(61, 60, 'down')).toBe(60);
		expect(alignTick(MIN_TICK, 60, 'down')).toBeGreaterThanOrEqual(MIN_TICK);
		expect(alignTick(MAX_TICK, 60, 'up')).toBeLessThanOrEqual(MAX_TICK);
	});

	it('refuses a spacing that is not a spacing', () => {
		expect(() => alignTick(0, 0)).toThrow(/tick spacing/);
	});
});

describe('ranges', () => {
	it('full range is the widest multiple of the spacing inside the bounds', () => {
		expect(fullRange(60)).toEqual({ tickLower: -887220, tickUpper: 887220 });
		expect(fullRange(1)).toEqual({ tickLower: MIN_TICK, tickUpper: MAX_TICK });
		expect(fullRange(200)).toEqual({ tickLower: -887200, tickUpper: 887200 });
	});

	it('a single-sided range starts at or above the current price', () => {
		const range = singleSidedRange({ currentTick: 0, spacing: 60, multiple: 1000 });
		expect(range.tickLower).toBeGreaterThanOrEqual(0);
		expect(range.tickUpper).toBeGreaterThan(range.tickLower);
		// 1000x is about ln(1000)/ln(1.0001) ticks wide.
		expect(range.tickUpper - range.tickLower).toBeGreaterThan(69000);
	});

	it('refuses a range that does not go up', () => {
		expect(() => singleSidedRange({ currentTick: 0, spacing: 60, multiple: 1 })).toThrow(/above the start price/);
	});
});

describe('liquidity', () => {
	it('is token0-only below the range', () => {
		const lower = sqrtPriceX96AtTick(60);
		const upper = sqrtPriceX96AtTick(120);
		const l = liquidityForAmounts({ sqrtPriceX96: sqrtPriceX96AtTick(0), sqrtPriceLowerX96: lower, sqrtPriceUpperX96: upper, amount0: 10n ** 18n, amount1: 0n });
		expect(l).toBe(liquidityForAmount0(lower, upper, 10n ** 18n));
		expect(l).toBeGreaterThan(0n);
	});

	it('is token1-only above the range', () => {
		const lower = sqrtPriceX96AtTick(-120);
		const upper = sqrtPriceX96AtTick(-60);
		const l = liquidityForAmounts({ sqrtPriceX96: sqrtPriceX96AtTick(0), sqrtPriceLowerX96: lower, sqrtPriceUpperX96: upper, amount0: 0n, amount1: 10n ** 18n });
		expect(l).toBe(liquidityForAmount1(lower, upper, 10n ** 18n));
	});

	it('takes the binding side when the price is inside the range', () => {
		const l = liquidityForAmounts({
			sqrtPriceX96: Q96,
			sqrtPriceLowerX96: sqrtPriceX96AtTick(-60),
			sqrtPriceUpperX96: sqrtPriceX96AtTick(60),
			amount0: 10n ** 18n,
			amount1: 1n,
		});
		// One wei of token1 cannot support the liquidity a whole token0 could.
		expect(l).toBeLessThan(liquidityForAmount0(Q96, sqrtPriceX96AtTick(60), 10n ** 18n));
	});

	it('refuses a range of zero width', () => {
		expect(() => liquidityForAmounts({ sqrtPriceX96: Q96, sqrtPriceLowerX96: Q96, sqrtPriceUpperX96: Q96, amount0: 1n, amount1: 1n })).toThrow(/wider than zero/);
	});

	it('puts the sqrt price at tick zero exactly at 2^96', () => {
		expect(sqrtPriceX96AtTick(0)).toBe(Q96);
	});
});

describe('token ordering', () => {
	it('sorts ascending by address', () => {
		expect(sortTokens('0xbb', '0xaa')).toEqual({ token0: '0xaa', token1: '0xbb', flipped: true });
		expect(sortTokens('0xaa', '0xbb')).toEqual({ token0: '0xaa', token1: '0xbb', flipped: false });
	});

	it('ignores case, because addresses do', () => {
		expect(sortTokens('0xAB', '0xac').flipped).toBe(false);
	});

	it('refuses a pool of one token', () => {
		expect(() => sortTokens('0xaa', '0xAA')).toThrow(/two different tokens/);
	});
});
