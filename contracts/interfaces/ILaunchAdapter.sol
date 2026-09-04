// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

/// @notice A pool a launch was opened into.
/// @param pool           The pool or pair contract.
/// @param positionToken  What represents ownership of the liquidity: an ERC-20 LP token,
///                       or the position-manager NFT contract.
/// @param positionId     Token id when `isErc721`, otherwise zero.
/// @param amount         LP token amount when not `isErc721`, otherwise one.
/// @param isErc721       Whether the position is an NFT rather than a fungible LP balance.
struct Position {
    address pool;
    address positionToken;
    uint256 positionId;
    uint256 amount;
    bool isErc721;
}

/// @param token        The launch token. The adapter is holding `tokenAmount` of it already.
/// @param tokenAmount  How much of the launch token to put in the pool.
/// @param quote        The quote asset, or address(0) for native ETH sent as msg.value.
/// @param quoteAmount  How much quote to put in the pool. May be zero for a one-sided launch.
/// @param recipient    Where the resulting position is sent. Never the adapter itself.
/// @param refundTo     Where anything the pool did not take is returned.
/// @param config       Adapter-specific pool configuration, ABI-encoded.
struct AddLiquidityParams {
    address token;
    uint256 tokenAmount;
    address quote;
    uint256 quoteAmount;
    address recipient;
    address refundTo;
    bytes config;
}

/// @title ILaunchAdapter
/// @notice Opens a pool for a freshly launched token on one AMM family.
///
/// Adapters are stateless and hold nothing between calls. The launcher moves
/// the launch token to the adapter, calls it once, and the adapter must send
/// the position to `recipient` and return every unused input to `refundTo`
/// before it returns. An adapter that keeps a balance is a bug, and
/// `RelayLauncher` checks for it rather than trusting the adapter not to.
interface ILaunchAdapter {
    /// @notice Human-readable AMM family this adapter targets, e.g. "uniswap-v3".
    function family() external view returns (string memory);

    /// @notice Create the pool if needed, add the liquidity, hand over the position.
    function addLiquidity(AddLiquidityParams calldata params) external payable returns (Position memory);

    /// @notice Decode and sanity-check a config blob without spending anything.
    /// @dev Lets a caller validate a launch off-chain against the exact code that will run it.
    function validate(bytes calldata config) external view;
}
