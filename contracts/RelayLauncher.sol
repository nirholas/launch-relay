// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import {AddLiquidityParams, ILaunchAdapter, Position} from "./interfaces/ILaunchAdapter.sol";
import {IERC20, IERC721} from "./interfaces/IERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchRegistry} from "./LaunchRegistry.sol";
import {LiquidityLocker} from "./LiquidityLocker.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title RelayLauncher
/// @notice Deploy a token, open its market, and lock the liquidity, in one
///         transaction that either does all of it or none of it.
///
/// Doing this without a launcher takes four transactions: deploy, approve,
/// create the pool, mint the position. Between any two of them the token
/// exists with a supply and no market, which is a window somebody else can
/// trade into, and the token's address has to be predicted from a nonce that
/// anything else using the wallet will invalidate. Neither problem is
/// theoretical and neither can be fixed off-chain.
///
/// So this contract collapses the four into one:
///
///   * **Atomic.** The token cannot exist without its pool. A launch that
///     fails anywhere leaves nothing behind.
///   * **Address known in advance.** CREATE2 with a salt namespaced by the
///     creator: the address is computable before the transaction, and nobody
///     else can take it, because their salt hashes with their address.
///   * **Locked on arrival.** The position goes straight from the adapter to
///     the locker. It is never in the creator's hands, so there is no moment
///     where a launch that advertises locked liquidity does not have it.
///   * **Recorded.** Every launch writes one canonical entry in the registry,
///     whichever AMM it used.
///
/// What governance can and cannot do is deliberately lopsided. The owner
/// registers adapters and sets a protocol fee under a cap that is immutable
/// and enforced by the constructor. The owner cannot touch a lock, cannot
/// withdraw anyone's liquidity, cannot change a token, and cannot upgrade this
/// contract, because it is not upgradeable. Disabling every adapter is the
/// worst it can do, and that stops new launches without touching old ones.
contract RelayLauncher {
    using SafeTransfer for address;

    /// @notice The most the protocol fee can ever be, in basis points. Immutable by construction.
    uint16 public constant MAX_FEE_BPS = 100; // 1%

    /// @param name          Token name.
    /// @param symbol        Token symbol.
    /// @param metadataURI   Off-chain descriptor. Immutable on the token once set.
    /// @param decimals      Token decimals.
    /// @param supply        Total supply, minted once, in the constructor.
    /// @param salt          Creator-chosen salt. Namespaced by msg.sender before use.
    /// @param adapter       Registered AMM adapter that will open the pool.
    /// @param adapterConfig Adapter-specific pool configuration.
    /// @param supplyToPool  How much of the supply goes into the pool. The rest goes to the creator.
    /// @param quote         Quote asset, or address(0) for native ETH.
    /// @param quoteAmount   Quote deposited into the pool. May be zero for a one-sided launch.
    /// @param unlockAt      When the liquidity unlocks, or type(uint64).max for permanent.
    /// @param feeRecipient  Who collects trading fees from the locked position.
    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        uint8 decimals;
        uint256 supply;
        bytes32 salt;
        address adapter;
        bytes adapterConfig;
        uint256 supplyToPool;
        address quote;
        uint256 quoteAmount;
        uint64 unlockAt;
        address feeRecipient;
    }

    LiquidityLocker public immutable locker;
    LaunchRegistry public immutable registry;

    address public owner;
    address public pendingOwner;
    address public feeCollector;
    uint16 public feeBps;

    mapping(address => bool) public adapterEnabled;

    event Launched(
        address indexed token,
        address indexed creator,
        address indexed adapter,
        address pool,
        uint256 lockId,
        uint256 supplyToPool,
        uint256 quoteAmount,
        uint64 unlockAt
    );
    event AdapterSet(address indexed adapter, bool enabled, string family);
    event FeeSet(uint16 feeBps, address collector);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error AdapterNotEnabled(address adapter);
    error FeeTooHigh(uint16 requested, uint16 max);
    error SupplyTooLow();
    error PoolSupplyExceedsSupply();
    error ZeroFeeRecipient();
    error WrongNativeValue(uint256 expected, uint256 received);
    error AdapterKeptFunds(address token, uint256 amount);
    error AdapterReturnedNoPosition();
    error Reentrancy();

    uint256 private _entered = 1;

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner, address feeCollector_, LiquidityLocker locker_, LaunchRegistry registry_) {
        owner = initialOwner;
        feeCollector = feeCollector_;
        locker = locker_;
        registry = registry_;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    // ── launching ───────────────────────────────────────────────────────────

    /// @notice The address a launch will deploy to, before it is sent.
    /// @dev Salts are namespaced by the creator, so two people can use the same
    ///      salt and neither can take the other's address.
    function predictToken(address creator, bytes32 salt, LaunchParams calldata params)
        external
        view
        returns (address)
    {
        return _predict(creator, salt, params);
    }

    function _predict(address creator, bytes32 salt, LaunchParams calldata params) private view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(LaunchToken).creationCode,
                abi.encode(params.name, params.symbol, params.decimals, params.supply, params.metadataURI, address(this))
            )
        );
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _namespaced(creator, salt), initCodeHash)))
            )
        );
    }

    function _namespaced(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(creator, salt));
    }

    /// @notice Deploy, pool, lock and record, atomically.
    function launch(LaunchParams calldata params)
        external
        payable
        nonReentrant
        returns (address token, uint256 lockId, address pool)
    {
        if (!adapterEnabled[params.adapter]) revert AdapterNotEnabled(params.adapter);
        if (params.supply == 0) revert SupplyTooLow();
        if (params.supplyToPool == 0 || params.supplyToPool > params.supply) revert PoolSupplyExceedsSupply();
        if (params.feeRecipient == address(0)) revert ZeroFeeRecipient();

        uint256 fee = (msg.value * feeBps) / 10_000;
        uint256 nativeForPool = params.quote == address(0) ? params.quoteAmount : 0;
        // Everything sent has to be accounted for. A launch that quietly keeps
        // the change is a launch that will keep more of it later.
        if (msg.value != nativeForPool + fee) revert WrongNativeValue(nativeForPool + fee, msg.value);

        token = address(
            new LaunchToken{salt: _namespaced(msg.sender, params.salt)}(
                params.name, params.symbol, params.decimals, params.supply, params.metadataURI, address(this)
            )
        );

        if (params.quote != address(0) && params.quoteAmount != 0) {
            params.quote.safeTransferFrom(msg.sender, address(this), params.quoteAmount);
            params.quote.safeTransfer(params.adapter, params.quoteAmount);
        }
        token.safeTransfer(params.adapter, params.supplyToPool);

        Position memory position = ILaunchAdapter(params.adapter).addLiquidity{value: nativeForPool}(
            AddLiquidityParams({
                token: token,
                tokenAmount: params.supplyToPool,
                quote: params.quote,
                quoteAmount: params.quoteAmount,
                recipient: address(this),
                refundTo: address(this),
                config: params.adapterConfig
            })
        );
        if (position.positionToken == address(0)) revert AdapterReturnedNoPosition();
        _assertAdapterIsEmpty(params.adapter, token, params.quote);

        lockId = _lock(position, params.feeRecipient, params.unlockAt);

        // Whatever the pool did not take belongs to the creator, including the
        // untouched share of supply.
        _sweep(token, msg.sender);
        if (params.quote != address(0)) _sweep(params.quote, msg.sender);
        if (fee != 0) feeCollector.safeTransferNative(fee);

        pool = position.pool;
        registry.register(token, msg.sender, pool, keccak256(params.adapterConfig), lockId);
        emit Launched(
            token, msg.sender, params.adapter, pool, lockId, params.supplyToPool, params.quoteAmount, params.unlockAt
        );
    }

    /// @dev The locker pulls rather than receives, so that the transfer and the
    ///      recording of the lock are the same call and a position can never
    ///      sit in the locker unlocked.
    function _lock(Position memory position, address beneficiary, uint64 unlockAt) private returns (uint256 lockId) {
        if (position.isErc721) {
            IERC721(position.positionToken).approve(address(locker), position.positionId);
            return locker.lockPosition(position.positionToken, position.positionId, beneficiary, unlockAt);
        }
        position.positionToken.safeApprove(address(locker), position.amount);
        lockId = locker.lockTokens(position.positionToken, position.amount, beneficiary, unlockAt);
    }

    /// @dev An adapter is required to end every call holding nothing. Checking
    ///      is cheap and turns a silently drained launch into a revert.
    function _assertAdapterIsEmpty(address adapter, address token, address quote) private view {
        uint256 stuck = IERC20(token).balanceOf(adapter);
        if (stuck != 0) revert AdapterKeptFunds(token, stuck);
        if (quote != address(0)) {
            stuck = IERC20(quote).balanceOf(adapter);
            if (stuck != 0) revert AdapterKeptFunds(quote, stuck);
        }
    }

    function _sweep(address token, address to) private {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != 0) token.safeTransfer(to, balance);
    }

    // ── governance ──────────────────────────────────────────────────────────

    /// @notice Enable or disable an AMM adapter.
    /// @dev Adapters are never swapped in place: enabling a new one and
    ///      disabling the old one are separate acts, and a launch that already
    ///      happened is unaffected by either.
    function setAdapter(address adapter, bool enabled) external onlyOwner {
        adapterEnabled[adapter] = enabled;
        emit AdapterSet(adapter, enabled, enabled ? ILaunchAdapter(adapter).family() : "");
    }

    function setFee(uint16 bps, address collector) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh(bps, MAX_FEE_BPS);
        feeBps = bps;
        feeCollector = collector;
        emit FeeSet(bps, collector);
    }

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

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
