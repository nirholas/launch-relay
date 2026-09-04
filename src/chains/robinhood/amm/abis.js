// The AMM interfaces a pool launch touches, trimmed to what it calls.
//
// Written out here rather than pulled from a vendor package so the toolkit
// stays on one dependency, and so a reader can see the exact surface a launch
// is allowed to use. Everything below is the standard Uniswap V2 / V3 / V4
// periphery shape, which the forks on this chain implement unchanged.

import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
	'function balanceOf(address) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function approve(address spender, uint256 value) returns (bool)',
]);

export const v2FactoryAbi = parseAbi([
	'function getPair(address tokenA, address tokenB) view returns (address pair)',
	'function createPair(address tokenA, address tokenB) returns (address pair)',
	'function allPairsLength() view returns (uint256)',
]);

export const v2RouterAbi = parseAbi([
	'function factory() view returns (address)',
	'function WETH() view returns (address)',
	'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
	'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
]);

export const v3FactoryAbi = parseAbi([
	'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
	'function feeAmountTickSpacing(uint24 fee) view returns (int24)',
]);

export const v3PoolAbi = parseAbi([
	'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
	'function liquidity() view returns (uint128)',
]);

export const v3PositionManagerAbi = parseAbi([
	'function factory() view returns (address)',
	'function WETH9() view returns (address)',
	'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
	'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
	'function refundETH() payable',
	'function multicall(bytes[] data) payable returns (bytes[] results)',
]);

export const v4PositionManagerAbi = parseAbi([
	'function poolManager() view returns (address)',
	'function permit2() view returns (address)',
	'function initializePool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24 tick)',
	'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
	'function multicall(bytes[] data) payable returns (bytes[] results)',
	'function nextTokenId() view returns (uint256)',
]);

export const v4PoolManagerAbi = parseAbi([
	'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

export const permit2Abi = parseAbi([
	'function approve(address token, address spender, uint160 amount, uint48 expiration)',
	'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);

/**
 * Uniswap V4 encodes a position operation as a byte string of action ids and a
 * parallel array of ABI-encoded parameters. Only the three a launch needs are
 * defined here; the numbering is the protocol's own.
 */
export const V4_ACTIONS = Object.freeze({
	MINT_POSITION: 0x02,
	SETTLE_PAIR: 0x0d,
	SWEEP: 0x14,
});
