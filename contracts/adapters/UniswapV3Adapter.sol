// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import {AddLiquidityParams, ILaunchAdapter, Position} from "../interfaces/ILaunchAdapter.sol";
import {IERC20, IERC721, IWETH} from "../interfaces/IERC20.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

/// @title UniswapV3Adapter
/// @notice Opens a concentrated-liquidity pool for a launch, in either shape a
///         launch actually wants.
///
/// Full range behaves like a constant-product pool with better fee capture and
/// needs both sides funded. A range that sits entirely above the starting
/// price needs no quote at all: the whole supply is offered for sale upward
/// and the pool fills with quote as people buy. The second is the one that
/// makes a launch possible without launch capital, and it is why this adapter
/// exists rather than only the V2 one.
///
/// The starting price is a caller input, not something this contract derives.
/// A pool's initial price is the single most consequential number in a launch:
/// get it wrong and the first arbitrageur takes the difference, and it cannot
/// be set twice. Computing it off-chain, showing it to a human, and passing it
/// in is the only version of that where somebody has looked at the number.
contract UniswapV3Adapter is ILaunchAdapter {
    using SafeTransfer for address;

    /// @param fee            Fee tier in hundredths of a bip. 10000 is 1%.
    /// @param sqrtPriceX96   Starting price, as the AMM stores it.
    /// @param tickLower      Lower bound of the position, aligned to the tier's spacing.
    /// @param tickUpper      Upper bound of the position, aligned to the tier's spacing.
    struct Config {
        uint24 fee;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
    }

    IUniswapV3Factory public immutable factory;
    INonfungiblePositionManager public immutable positionManager;
    IWETH public immutable weth;

    error PoolExists(address pool);
    error FeeTierDisabled(uint24 fee);
    error TicksOutOfOrder(int24 lower, int24 upper);
    error TickNotAligned(int24 tick, int24 spacing);
    error ZeroPrice();
    error NothingMinted();

    constructor(address factory_, address positionManager_, address weth_) {
        factory = IUniswapV3Factory(factory_);
        positionManager = INonfungiblePositionManager(positionManager_);
        weth = IWETH(weth_);
    }

    function family() external pure returns (string memory) {
        return "uniswap-v3";
    }

    /// @notice Check a config without spending anything.
    /// @dev The same code the launch path runs, so a caller can prove their
    ///      parameters are acceptable before funding a wallet.
    function validate(bytes calldata config) external view {
        _check(abi.decode(config, (Config)));
    }

    function _check(Config memory cfg) private view returns (int24 spacing) {
        if (cfg.sqrtPriceX96 == 0) revert ZeroPrice();
        spacing = factory.feeAmountTickSpacing(cfg.fee);
        if (spacing == 0) revert FeeTierDisabled(cfg.fee);
        if (cfg.tickLower >= cfg.tickUpper) revert TicksOutOfOrder(cfg.tickLower, cfg.tickUpper);
        // An unaligned tick is not a position boundary and the pool rejects it.
        // Catching it here turns a bare revert deep inside the AMM into a
        // message that names the tick and the spacing it had to be a multiple of.
        if (cfg.tickLower % spacing != 0) revert TickNotAligned(cfg.tickLower, spacing);
        if (cfg.tickUpper % spacing != 0) revert TickNotAligned(cfg.tickUpper, spacing);
    }

    function addLiquidity(AddLiquidityParams calldata params)
        external
        payable
        returns (Position memory position)
    {
        Config memory cfg = abi.decode(params.config, (Config));
        _check(cfg);

        address quote = params.quote;
        if (quote == address(0)) {
            // V3 has no native side; the pool is against WETH either way.
            if (params.quoteAmount != 0) weth.deposit{value: params.quoteAmount}();
            quote = address(weth);
        }

        address existing = factory.getPool(params.token, quote, cfg.fee);
        if (existing != address(0)) revert PoolExists(existing);

        (address token0, address token1) = params.token < quote
            ? (params.token, quote)
            : (quote, params.token);
        (uint256 amount0, uint256 amount1) = params.token < quote
            ? (params.tokenAmount, params.quoteAmount)
            : (params.quoteAmount, params.tokenAmount);

        positionManager.createAndInitializePoolIfNecessary(token0, token1, cfg.fee, cfg.sqrtPriceX96);

        params.token.safeApprove(address(positionManager), params.tokenAmount);
        if (params.quoteAmount != 0) quote.safeApprove(address(positionManager), params.quoteAmount);

        // The pool was initialised by this same call, so there is nothing to
        // slip against and zero minimums are correct here. On an existing pool
        // they would be reckless.
        (uint256 tokenId, uint128 liquidity,,) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: cfg.fee,
                tickLower: cfg.tickLower,
                tickUpper: cfg.tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        if (liquidity == 0) revert NothingMinted();

        // The position lands here first so the approval can be cleared and the
        // remainder refunded before it leaves. A one-sided mint routinely takes
        // less than it was offered.
        params.token.safeApprove(address(positionManager), 0);
        if (params.quoteAmount != 0) quote.safeApprove(address(positionManager), 0);
        IERC721(address(positionManager)).safeTransferFrom(address(this), params.recipient, tokenId);

        _refund(params.token, params.refundTo);
        _refund(quote, params.refundTo);

        position = Position({
            pool: factory.getPool(params.token, quote, cfg.fee),
            positionToken: address(positionManager),
            positionId: tokenId,
            amount: 1,
            isErc721: true
        });
    }

    function _refund(address token, address to) private {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != 0) token.safeTransfer(to, balance);
    }

    /// @dev The position manager mints to this contract before it is forwarded.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
