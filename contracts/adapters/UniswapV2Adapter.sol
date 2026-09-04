// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import {AddLiquidityParams, ILaunchAdapter, Position} from "../interfaces/ILaunchAdapter.sol";
import {IERC20, IWETH} from "../interfaces/IERC20.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Router {
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

/// @title UniswapV2Adapter
/// @notice Opens a constant-product pool for a launch.
///
/// The simplest thing that can be called a market: one curve from zero to
/// infinity, both sides funded, no ticks and no ranges. It cannot do a
/// one-sided launch, because a constant-product pool with one empty reserve
/// has no price, so this adapter requires a quote deposit and says so rather
/// than silently opening something unusable.
///
/// The factory address is a constructor argument rather than a constant so the
/// same code serves the V2 forks on this chain. Nothing here is Uniswap
/// specific beyond the interface every one of them implements.
contract UniswapV2Adapter is ILaunchAdapter {
    using SafeTransfer for address;

    IUniswapV2Factory public immutable factory;
    IUniswapV2Router public immutable router;
    IWETH public immutable weth;

    error QuoteRequired();
    error PairExists(address pair);
    error NothingReturned();

    constructor(address factory_, address router_, address weth_) {
        factory = IUniswapV2Factory(factory_);
        router = IUniswapV2Router(router_);
        weth = IWETH(weth_);
    }

    function family() external pure returns (string memory) {
        return "uniswap-v2";
    }

    /// @dev V2 has no configuration: one fee, one curve, no range.
    function validate(bytes calldata) external pure {}

    function addLiquidity(AddLiquidityParams calldata params)
        external
        payable
        returns (Position memory position)
    {
        if (params.quoteAmount == 0) revert QuoteRequired();

        // Native ETH is wrapped here rather than routed through the router's
        // ETH helper, so both branches below take exactly the same path and
        // there is only one set of behaviour to reason about.
        address quote = params.quote;
        if (quote == address(0)) {
            weth.deposit{value: params.quoteAmount}();
            quote = address(weth);
        }

        // A pair that already exists has a price somebody else set, and adding
        // to it would value the launch at whatever that is. A launch opens its
        // own market or it does not launch.
        address existing = factory.getPair(params.token, quote);
        if (existing != address(0)) revert PairExists(existing);

        params.token.safeApprove(address(router), params.tokenAmount);
        quote.safeApprove(address(router), params.quoteAmount);

        // The pair is created by this same call, so there is no existing
        // liquidity to slip against and the minimums are the full amounts:
        // anything less means the router did something unexpected.
        (,, uint256 liquidity) = router.addLiquidity(
            params.token,
            quote,
            params.tokenAmount,
            params.quoteAmount,
            params.tokenAmount,
            params.quoteAmount,
            params.recipient,
            block.timestamp
        );
        if (liquidity == 0) revert NothingReturned();

        address pair = factory.getPair(params.token, quote);
        position = Position({
            pool: pair,
            positionToken: pair,
            positionId: 0,
            amount: liquidity,
            isErc721: false
        });

        _refund(params.token, params.refundTo);
        _refund(quote, params.refundTo);
    }

    /// @dev The router takes exactly what it was told to, but an approval or a
    ///      rounding remainder can still leave dust. It belongs to the launcher,
    ///      not to this contract, which is required to end every call empty.
    function _refund(address token, address to) private {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != 0) token.safeTransfer(to, balance);
    }
}
