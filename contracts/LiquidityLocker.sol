// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import {IERC20, IERC721} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

interface INonfungiblePositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

/// @title LiquidityLocker
/// @notice Holds launch liquidity so that "the liquidity is locked" is a fact
///         a buyer can check rather than a claim they have to believe.
///
/// A launch is a promise made to strangers, and the only part of it that can
/// be made checkable is what happens to the liquidity. This contract is that
/// part, and it is deliberately small: it takes custody of an LP balance or a
/// position NFT, it lets the beneficiary collect trading fees, and it lets
/// nobody take the liquidity back before the time they committed to.
///
/// Three properties are structural rather than promised:
///
///   1. **A permanent lock is permanent.** `unlockAt == type(uint64).max` has
///      no branch that releases it. Not for the beneficiary, not for a
///      governance address, not after any amount of time. There is no owner on
///      this contract at all, so there is nothing to compromise.
///   2. **A lock can only get longer.** `extend` refuses any timestamp earlier
///      than the current one, and refuses to touch a permanent lock. A creator
///      cannot quietly shorten what they committed to.
///   3. **Fees go where the beneficiary says, and only there.** Collecting is
///      the one thing a lock allows while it is running, and only the
///      beneficiary can do it.
///
/// The beneficiary is transferable on purpose. Fee rights on a locked position
/// are a real asset, and forcing them to stay with the launching wallet would
/// mean the only way to sell them is to not lock in the first place.
contract LiquidityLocker {
    using SafeTransfer for address;

    /// @notice The unlock timestamp that means "never".
    uint64 public constant PERMANENT = type(uint64).max;

    struct Lock {
        /// @dev The LP token contract, or the position manager for an NFT position.
        address positionToken;
        /// @dev Token id for an NFT position, zero for a fungible LP balance.
        uint256 positionId;
        /// @dev LP amount for a fungible balance, one for an NFT position.
        uint256 amount;
        address beneficiary;
        uint64 unlockAt;
        bool isErc721;
        bool withdrawn;
    }

    mapping(uint256 => Lock) private _locks;

    /// @notice Ids start at one so that zero can mean "no lock" everywhere else.
    uint256 public nextLockId = 1;

    event Locked(
        uint256 indexed lockId,
        address indexed beneficiary,
        address indexed positionToken,
        uint256 positionId,
        uint256 amount,
        uint64 unlockAt
    );
    event Extended(uint256 indexed lockId, uint64 previousUnlockAt, uint64 unlockAt);
    event BeneficiaryTransferred(uint256 indexed lockId, address indexed from, address indexed to);
    event FeesCollected(uint256 indexed lockId, address indexed recipient, uint256 amount0, uint256 amount1);
    event Withdrawn(uint256 indexed lockId, address indexed recipient);

    error NoSuchLock();
    error NotBeneficiary();
    error AlreadyWithdrawn();
    error StillLocked(uint64 unlockAt);
    error LockIsPermanent();
    error CannotShorten(uint64 current, uint64 requested);
    error UnlockInThePast();
    error ZeroBeneficiary();
    error ZeroAmount();
    error NotAnNftPosition();

    /// @notice Take custody of a fungible LP balance.
    /// @dev The caller must have approved this contract for `amount` first.
    function lockTokens(address positionToken, uint256 amount, address beneficiary, uint64 unlockAt)
        external
        returns (uint256 lockId)
    {
        if (amount == 0) revert ZeroAmount();
        positionToken.safeTransferFrom(msg.sender, address(this), amount);
        lockId = _record(positionToken, 0, amount, beneficiary, unlockAt, false);
    }

    /// @notice Take custody of a position NFT.
    /// @dev The caller must have approved this contract for `positionId` first.
    function lockPosition(address positionToken, uint256 positionId, address beneficiary, uint64 unlockAt)
        external
        returns (uint256 lockId)
    {
        IERC721(positionToken).transferFrom(msg.sender, address(this), positionId);
        lockId = _record(positionToken, positionId, 1, beneficiary, unlockAt, true);
    }

    function _record(
        address positionToken,
        uint256 positionId,
        uint256 amount,
        address beneficiary,
        uint64 unlockAt,
        bool isErc721
    ) private returns (uint256 lockId) {
        if (beneficiary == address(0)) revert ZeroBeneficiary();
        // A lock that has already expired is not a lock. Refusing it here means
        // a launch cannot advertise a lock that was never one.
        if (unlockAt != PERMANENT && unlockAt <= block.timestamp) revert UnlockInThePast();

        lockId = nextLockId++;
        _locks[lockId] = Lock({
            positionToken: positionToken,
            positionId: positionId,
            amount: amount,
            beneficiary: beneficiary,
            unlockAt: unlockAt,
            isErc721: isErc721,
            withdrawn: false
        });
        emit Locked(lockId, beneficiary, positionToken, positionId, amount, unlockAt);
    }

    /// @notice Read a lock. Reverts rather than returning an empty struct for an unknown id.
    function getLock(uint256 lockId) external view returns (Lock memory lock) {
        lock = _locks[lockId];
        if (lock.positionToken == address(0)) revert NoSuchLock();
    }

    /// @notice Whether the liquidity behind a lock can never be taken out again.
    function isPermanent(uint256 lockId) external view returns (bool) {
        return _locks[lockId].unlockAt == PERMANENT;
    }

    /// @notice Collect accrued trading fees from a locked position.
    /// @dev Concentrated-liquidity positions accrue fees separately from the
    ///      principal, so this is the one value a lock lets out while it runs.
    ///      Constant-product LP shares do not: their fees compound into the
    ///      reserves the LP balance represents, and a permanently locked V2
    ///      position therefore earns fees that nobody can ever withdraw. That
    ///      is a property of the AMM, not of this contract, and it is why
    ///      `lockTokens` reverts here instead of pretending to collect.
    function collectFees(uint256 lockId, address recipient)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        Lock storage lock = _locks[lockId];
        if (lock.positionToken == address(0)) revert NoSuchLock();
        if (msg.sender != lock.beneficiary) revert NotBeneficiary();
        if (lock.withdrawn) revert AlreadyWithdrawn();
        if (!lock.isErc721) revert NotAnNftPosition();
        if (recipient == address(0)) revert ZeroBeneficiary();

        (amount0, amount1) = INonfungiblePositionManager(lock.positionToken).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: lock.positionId,
                recipient: recipient,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(lockId, recipient, amount0, amount1);
    }

    /// @notice Push the unlock further out, or make it permanent.
    /// @dev One direction only. A creator can strengthen what they committed
    ///      to and can never weaken it, which is what makes the original
    ///      commitment worth reading.
    function extend(uint256 lockId, uint64 unlockAt) external {
        Lock storage lock = _locks[lockId];
        if (lock.positionToken == address(0)) revert NoSuchLock();
        if (msg.sender != lock.beneficiary) revert NotBeneficiary();
        if (lock.withdrawn) revert AlreadyWithdrawn();
        if (lock.unlockAt == PERMANENT) revert LockIsPermanent();
        if (unlockAt <= lock.unlockAt) revert CannotShorten(lock.unlockAt, unlockAt);

        uint64 previous = lock.unlockAt;
        lock.unlockAt = unlockAt;
        emit Extended(lockId, previous, unlockAt);
    }

    /// @notice Hand the fee rights, and the eventual withdrawal, to somebody else.
    function transferBeneficiary(uint256 lockId, address to) external {
        Lock storage lock = _locks[lockId];
        if (lock.positionToken == address(0)) revert NoSuchLock();
        if (msg.sender != lock.beneficiary) revert NotBeneficiary();
        if (to == address(0)) revert ZeroBeneficiary();

        lock.beneficiary = to;
        emit BeneficiaryTransferred(lockId, msg.sender, to);
    }

    /// @notice Take the liquidity back, once the lock has run out.
    function withdraw(uint256 lockId, address recipient) external {
        Lock storage lock = _locks[lockId];
        if (lock.positionToken == address(0)) revert NoSuchLock();
        if (msg.sender != lock.beneficiary) revert NotBeneficiary();
        if (lock.withdrawn) revert AlreadyWithdrawn();
        if (lock.unlockAt == PERMANENT) revert LockIsPermanent();
        if (block.timestamp < lock.unlockAt) revert StillLocked(lock.unlockAt);
        if (recipient == address(0)) revert ZeroBeneficiary();

        lock.withdrawn = true;
        if (lock.isErc721) {
            IERC721(lock.positionToken).transferFrom(address(this), recipient, lock.positionId);
        } else {
            lock.positionToken.safeTransfer(recipient, lock.amount);
        }
        emit Withdrawn(lockId, recipient);
    }

    /// @notice Accept position NFTs sent with `safeTransferFrom`.
    /// @dev Returning the selector only acknowledges receipt. A position that
    ///      arrives this way is held but not locked, because a lock needs a
    ///      beneficiary and an unlock time that a bare transfer cannot carry.
    ///      Use `lockPosition`.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
