// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

/// @title LaunchToken
/// @notice A fixed-supply ERC-20 with no owner, no mint, and no pause.
///
/// Every unit is minted to the deployer in the constructor and the constructor
/// is the only place that can ever create supply. There is no owner, no admin
/// role, and no upgrade path: once the deployment transaction is mined the
/// contract's behaviour is fixed forever. That is deliberate. A launch token
/// whose deployer can mint more of it, freeze a holder, or swap the
/// implementation is not a launch, it is a promise, and buyers cannot tell the
/// difference from the outside.
///
/// The one piece of mutable state beyond balances is `metadataURI`, and only
/// because a launchpad needs somewhere to point at a logo. It is set once in
/// the constructor and cannot be changed afterwards either.
contract LaunchToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable totalSupply;

    /// @notice Off-chain descriptor (logo, description, socials). Immutable after deploy.
    string public metadataURI;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 totalSupply_,
        string memory metadataURI_,
        address mintTo_
    ) {
        if (mintTo_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        totalSupply = totalSupply_;
        metadataURI = metadataURI_;
        balanceOf[mintTo_] = totalSupply_;
        emit Transfer(address(0), mintTo_, totalSupply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
