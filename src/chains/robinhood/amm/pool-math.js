// The arithmetic a pool launch needs, and nothing else.
//
// Concentrated-liquidity AMMs price a pool with a Q64.96 square root and index
// it with a tick. Both are easy to get subtly wrong and expensive to get wrong
// at all: a launch that initialises a pool at the wrong price hands the first
// arbitrageur the difference, and the pool cannot be re-initialised.
//
// Everything here is integer arithmetic where the result must be exact and
// floating point only where the result is immediately snapped to a tick
// spacing anyway, so the imprecision cannot survive into a transaction.

/** The tick range a concentrated pool can address, from the AMM's own bounds. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

const Q96 = 2n ** 96n;

/**
 * Integer square root, rounded down. Newton's method on bigints, because the
 * value being rooted is up to 2^256 and Number loses it at 2^53.
 *
 * @param {bigint} value
 * @returns {bigint}
 */
export function bigIntSqrt(value) {
	if (value < 0n) throw new Error('cannot take the square root of a negative');
	if (value < 2n) return value;
	let x = value;
	let y = (x + 1n) / 2n;
	while (y < x) {
		x = y;
		y = (x + value / x) / 2n;
	}
	return x;
}

/**
 * The Q64.96 square-root price for a pool holding `amount1` of token1 against
 * `amount0` of token0.
 *
 * Both amounts are in base units, so a pool quoted in USDG (6 decimals)
 * against an 18-decimal launch token is expressed correctly without the caller
 * having to think about the decimal difference: the ratio of base units *is*
 * the price the pool stores.
 *
 * @param {bigint} amount1
 * @param {bigint} amount0
 * @returns {bigint}
 */
export function encodeSqrtPriceX96(amount1, amount0) {
	if (amount0 <= 0n) throw new Error('token0 amount must be positive');
	if (amount1 <= 0n) throw new Error('token1 amount must be positive');
	return bigIntSqrt((amount1 * Q96 * Q96) / amount0);
}

/**
 * The price, as token1 per token0 in base units, that a sqrt price encodes.
 *
 * @param {bigint} sqrtPriceX96
 * @returns {number}
 */
export function decodeSqrtPriceX96(sqrtPriceX96) {
	const ratio = Number(sqrtPriceX96) / Number(Q96);
	return ratio * ratio;
}

/**
 * The tick whose price is at or below `price`.
 *
 * Ticks are logarithmic, 1.0001 per step, so this is a logarithm. Doing it in
 * double precision is fine because every caller snaps the result to a tick
 * spacing of at least 1, which is a wider grid than the error.
 *
 * @param {number} price token1 per token0, base units
 * @returns {number}
 */
export function priceToTick(price) {
	if (!(price > 0)) throw new Error('price must be positive');
	const tick = Math.floor(Math.log(price) / Math.log(1.0001));
	return clampTick(tick);
}

/**
 * @param {number} tick
 * @returns {number} token1 per token0, base units
 */
export function tickToPrice(tick) {
	return 1.0001 ** clampTick(tick);
}

/** @param {number} tick */
export function clampTick(tick) {
	return Math.min(MAX_TICK, Math.max(MIN_TICK, Math.trunc(tick)));
}

/**
 * Snap a tick onto a pool's spacing. A tick that is not a multiple of the
 * spacing is not a position boundary, and the AMM rejects it.
 *
 * @param {number} tick
 * @param {number} spacing
 * @param {'down'|'up'|'nearest'} [direction]
 */
export function alignTick(tick, spacing, direction = 'nearest') {
	if (!Number.isInteger(spacing) || spacing < 1) throw new Error(`invalid tick spacing ${spacing}`);
	const raw = clampTick(tick) / spacing;
	const snapped = direction === 'down' ? Math.floor(raw) : direction === 'up' ? Math.ceil(raw) : Math.round(raw);
	let result = snapped * spacing;
	// Snapping outward can leave the bound outside what the AMM accepts.
	while (result < MIN_TICK) result += spacing;
	while (result > MAX_TICK) result -= spacing;
	return result;
}

/**
 * The widest position a pool with this spacing can hold. Full range is the
 * right default for a launch: it is the only range that never goes out of
 * range, so the pool cannot end up with a token nobody can buy.
 *
 * @param {number} spacing
 */
export function fullRange(spacing) {
	return { tickLower: alignTick(MIN_TICK, spacing, 'up'), tickUpper: alignTick(MAX_TICK, spacing, 'down') };
}

/**
 * A range that holds only token0, sitting entirely above the current price.
 *
 * This is what a launch with no quote capital does: every unit of the new
 * token is offered for sale from the starting price upward, and the pool fills
 * with quote as people buy. No launch capital, no matching deposit, and no way
 * for the launcher to sell into their own pool from the other side.
 *
 * @param {object} opts
 * @param {number} opts.currentTick
 * @param {number} opts.spacing
 * @param {number} [opts.multiple] Top of the range as a multiple of the start price. Default 1000x.
 */
export function singleSidedRange({ currentTick, spacing, multiple = 1000 }) {
	if (!(multiple > 1)) throw new Error('the top of a single-sided range must be above the start price');
	const tickLower = alignTick(currentTick, spacing, 'up');
	const span = Math.log(multiple) / Math.log(1.0001);
	const tickUpper = alignTick(tickLower + span, spacing, 'up');
	if (tickUpper <= tickLower) throw new Error('range collapsed to nothing; widen the multiple or use a finer tick spacing');
	return { tickLower, tickUpper };
}

/**
 * Order two token addresses the way every Uniswap-family pool does: ascending
 * by address. Which token is token0 decides what the price means, so this is
 * not cosmetic.
 *
 * @param {string} tokenA
 * @param {string} tokenB
 * @returns {{token0: string, token1: string, flipped: boolean}}
 */
export function sortTokens(tokenA, tokenB) {
	const a = String(tokenA).toLowerCase();
	const b = String(tokenB).toLowerCase();
	if (a === b) throw new Error('a pool needs two different tokens');
	return a < b
		? { token0: tokenA, token1: tokenB, flipped: false }
		: { token0: tokenB, token1: tokenA, flipped: true };
}

/**
 * How much liquidity a deposit buys.
 *
 * Liquidity is the constant that a concentrated position holds across its
 * range, and it is what the AMM actually stores; the token amounts are what
 * that constant works out to at the current price. Getting it from amounts is
 * three cases, and which one applies is decided by where the price sits
 * relative to the range.
 *
 * All three come from the same identity, that within a range the position
 * behaves as a constant-product pool offset so its reserves hit zero at the
 * range bounds. Nothing here is approximated: the arithmetic is integer and
 * rounds down, so a position is never told it holds more liquidity than the
 * deposit supports.
 *
 * @param {object} opts
 * @param {bigint} opts.sqrtPriceX96      Current pool price.
 * @param {bigint} opts.sqrtPriceLowerX96
 * @param {bigint} opts.sqrtPriceUpperX96
 * @param {bigint} opts.amount0
 * @param {bigint} opts.amount1
 * @returns {bigint}
 */
export function liquidityForAmounts({ sqrtPriceX96, sqrtPriceLowerX96, sqrtPriceUpperX96, amount0, amount1 }) {
	let lower = sqrtPriceLowerX96;
	let upper = sqrtPriceUpperX96;
	if (lower > upper) [lower, upper] = [upper, lower];
	if (upper === lower) throw new Error('a position needs a range wider than zero');

	if (sqrtPriceX96 <= lower) return liquidityForAmount0(lower, upper, amount0);
	if (sqrtPriceX96 >= upper) return liquidityForAmount1(lower, upper, amount1);
	const l0 = liquidityForAmount0(sqrtPriceX96, upper, amount0);
	const l1 = liquidityForAmount1(lower, sqrtPriceX96, amount1);
	return l0 < l1 ? l0 : l1;
}

/** Liquidity a token0-only deposit supports across [lower, upper]. */
export function liquidityForAmount0(sqrtLowerX96, sqrtUpperX96, amount0) {
	if (amount0 <= 0n) return 0n;
	const intermediate = (sqrtLowerX96 * sqrtUpperX96) / Q96;
	return (amount0 * intermediate) / (sqrtUpperX96 - sqrtLowerX96);
}

/** Liquidity a token1-only deposit supports across [lower, upper]. */
export function liquidityForAmount1(sqrtLowerX96, sqrtUpperX96, amount1) {
	if (amount1 <= 0n) return 0n;
	return (amount1 * Q96) / (sqrtUpperX96 - sqrtLowerX96);
}

/**
 * The sqrt price at a tick, to the precision this toolkit needs.
 *
 * Exactness matters for the pool's initial price, which is why
 * `encodeSqrtPriceX96` exists and takes amounts. This one converts a tick that
 * was itself snapped to a spacing, so it feeds range-bound arithmetic where a
 * last-bit difference cannot change a transaction's outcome.
 *
 * @param {number} tick
 * @returns {bigint}
 */
export function sqrtPriceX96AtTick(tick) {
	const price = tickToPrice(clampTick(tick));
	const sqrt = Math.sqrt(price);
	// Split the multiplication so the mantissa never has to hold 2^96.
	const scaled = BigInt(Math.floor(sqrt * 2 ** 32));
	return (scaled * Q96) / 2n ** 32n;
}
