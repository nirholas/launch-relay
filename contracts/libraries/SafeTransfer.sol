// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

/// @title SafeTransfer
/// @notice ERC-20 calls that survive tokens which do not return a bool.
///
/// A meaningful share of tokens predate the finalised ERC-20 return value and
/// return nothing at all. A plain typed call against one of those reverts on
/// the ABI decode, so a launcher that has to move an arbitrary quote asset
/// cannot use the typed interface. This is the usual low-level shape, kept in
/// one place so every call site behaves identically.
library SafeTransfer {
    error TransferFailed();
    error ApproveFailed();
    error NativeTransferFailed();

    function safeTransfer(address token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function safeApprove(address token, address spender, uint256 value) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }

    function safeTransferNative(address to, uint256 value) internal {
        (bool ok, ) = to.call{value: value}("");
        if (!ok) revert NativeTransferFailed();
    }
}
