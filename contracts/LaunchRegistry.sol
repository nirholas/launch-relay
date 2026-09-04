// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

/// @title LaunchRegistry
/// @notice One on-chain record of a launch, whichever venue it happened on.
///
/// Robinhood Chain has dozens of launchpads and no two agree on what a launch
/// event looks like. Some emit nothing useful, several are unverified, and a
/// handful route through a router so the transaction does not even name the
/// venue. The practical result is that "what launched today, where, and is its
/// liquidity locked" cannot be answered from the chain without a bespoke
/// indexer per venue.
///
/// This is the one shape they can all be written into. It does not replace a
/// venue's own events; it sits beside them so an indexer, a frontend, or a
/// buyer has a single place to look.
///
/// Registration is permissionless, because a registry only anyone can write to
/// is a registry only its owner can censor. What keeps it meaningful is that
/// every record carries who wrote it, and records written by an authorised
/// launcher are flagged. A frontend showing "launched through Relay, liquidity
/// locked" filters on that flag; a frontend showing "everything launched
/// today" does not. Nobody can forge the flag, and nobody can suppress a
/// record.
contract LaunchRegistry {
    struct Record {
        address token;
        address creator;
        /// @dev The launchpad contract, or the pool for a launch that used no launchpad.
        address venue;
        /// @dev Keccak of the venue descriptor the launch was built from, tying
        ///      a record back to the exact calldata shape in the catalog. Zero
        ///      when the launch did not go through a descriptor.
        bytes32 descriptorHash;
        /// @dev Lock id in the LiquidityLocker, or zero if the liquidity is not locked here.
        uint256 lockId;
        address registrar;
        uint64 registeredAt;
        /// @dev True only when an authorised launcher wrote the record.
        bool viaRelay;
    }

    address public owner;
    address public pendingOwner;

    /// @notice Contracts whose records carry the `viaRelay` flag.
    mapping(address => bool) public authorised;

    mapping(address => Record) private _records;
    address[] private _tokens;

    event Registered(
        address indexed token,
        address indexed creator,
        address indexed venue,
        bytes32 descriptorHash,
        uint256 lockId,
        address registrar,
        bool viaRelay
    );
    event AuthorisedSet(address indexed launcher, bool authorised);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error AlreadyRegistered(address token);
    error ZeroToken();

    constructor(address initialOwner) {
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Record a launch. Anyone may call; only an authorised launcher's
    ///         record is flagged as having gone through this protocol.
    function register(address token, address creator, address venue, bytes32 descriptorHash, uint256 lockId)
        external
        returns (bool viaRelay)
    {
        if (token == address(0)) revert ZeroToken();
        // First writer wins. A token can only be launched once, so a second
        // record for the same token is either a mistake or an attempt to
        // rewrite history, and neither should overwrite the first.
        if (_records[token].token != address(0)) revert AlreadyRegistered(token);

        viaRelay = authorised[msg.sender];
        _records[token] = Record({
            token: token,
            creator: creator,
            venue: venue,
            descriptorHash: descriptorHash,
            lockId: lockId,
            registrar: msg.sender,
            registeredAt: uint64(block.timestamp),
            viaRelay: viaRelay
        });
        _tokens.push(token);
        emit Registered(token, creator, venue, descriptorHash, lockId, msg.sender, viaRelay);
    }

    function recordOf(address token) external view returns (Record memory) {
        return _records[token];
    }

    function totalLaunches() external view returns (uint256) {
        return _tokens.length;
    }

    /// @notice Page through every registered token, newest last.
    function tokensAt(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = _tokens.length;
        if (offset >= total) return new address[](0);
        uint256 count = total - offset;
        if (count > limit) count = limit;
        page = new address[](count);
        for (uint256 i = 0; i < count; i++) page[i] = _tokens[offset + i];
    }

    function setAuthorised(address launcher, bool value) external onlyOwner {
        authorised[launcher] = value;
        emit AuthorisedSet(launcher, value);
    }

    /// @dev Two-step, so a mistyped address cannot orphan the registry.
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(msg.sender, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }
}
