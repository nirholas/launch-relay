# The Relay protocol

Four contracts, no proxy, no upgrade path. This is the reference; the
reasoning behind each design decision is in the source, and the shape of the
whole thing is in the [README](../README.md#the-relay-protocol).

| Contract | Source | What it is |
| --- | --- | --- |
| `RelayLauncher` | [contracts/RelayLauncher.sol](../contracts/RelayLauncher.sol) | The entry point. Deploy, pool, lock, record, atomically. |
| `LiquidityLocker` | [contracts/LiquidityLocker.sol](../contracts/LiquidityLocker.sol) | Custody of launch liquidity. No owner. |
| `LaunchRegistry` | [contracts/LaunchRegistry.sol](../contracts/LaunchRegistry.sol) | One record per launch, whichever venue it used. |
| `LaunchToken` | [contracts/LaunchToken.sol](../contracts/LaunchToken.sol) | Fixed supply, no owner, no mint. |
| `UniswapV2Adapter` | [contracts/adapters/UniswapV2Adapter.sol](../contracts/adapters/UniswapV2Adapter.sol) | Constant-product pools. |
| `UniswapV3Adapter` | [contracts/adapters/UniswapV3Adapter.sol](../contracts/adapters/UniswapV3Adapter.sol) | Concentrated pools, full range or one-sided. |

Compiled with solc 0.8.36, optimizer on, one million runs. The artifacts are
committed under `src/chains/robinhood/artifacts/` so that installing the
package does not pull a Solidity compiler and the bytecode a launch deploys is
reviewable in the same diff as the source it came from.

```bash
npm run build:contracts    # recompile; output is deterministic for a given compiler
```

## Launching

```solidity
function launch(LaunchParams calldata params)
    external payable
    returns (address token, uint256 lockId, address pool);
```

```solidity
struct LaunchParams {
    string name;
    string symbol;
    string metadataURI;   // immutable on the token once set
    uint8 decimals;
    uint256 supply;       // minted once, in the constructor
    bytes32 salt;         // yours; hashed with your address before use
    address adapter;      // a registered AMM adapter
    bytes adapterConfig;  // adapter-specific pool configuration
    uint256 supplyToPool; // the rest goes to you
    address quote;        // address(0) for native ETH
    uint256 quoteAmount;  // may be zero for a one-sided launch
    uint64 unlockAt;      // type(uint64).max for a permanent lock
    address feeRecipient; // who collects the pool's trading fees
}
```

Everything sent has to be accounted for: `msg.value` must equal the native side
of the pool plus the protocol fee exactly. A launcher that quietly keeps the
change is a launcher that will keep more of it later.

Build the struct with the library rather than by hand, and the pool price, the
tick alignment and the token address all come out of the same code the tests
exercise:

```js
import { buildDeployment, buildLaunch, PERMANENT } from 'launch-relay';

const { addresses } = buildDeployment({ deployer, nonce });
const launch = buildLaunch({
  launcher: addresses.launcher,
  creator: deployer,
  adapter: addresses.adapters['uniswap-v3'],
  amm: 'uniswap-v3',
  token: { name: 'Loop Rat', symbol: 'LOOPRAT' },
  salt: '0x…',
  pool: { type: 'single-sided', fee: 10_000, startFdv: 2 },
  unlockAt: PERMANENT,
});

launch.tokenAddress;  // where it will land, before anything is sent
launch.params;        // the struct
launch.nativeValue;   // what to send with it
```

## Knowing the address in advance

```solidity
function predictToken(address creator, bytes32 salt, LaunchParams calldata params)
    external view returns (address);
```

CREATE2 from the launcher, over `LaunchToken`'s creation code, with the salt
hashed together with the creator's address. Two people can pick the same salt
and neither can take the other's address.

The library computes the same value off-chain with `predictLaunchToken`, and
the on-chain test suite fails if the two ever disagree. That check exists
because a predicted address is only useful if it is the address you get.

## Locking

```solidity
function lockTokens(address positionToken, uint256 amount, address beneficiary, uint64 unlockAt) external returns (uint256 lockId);
function lockPosition(address positionToken, uint256 positionId, address beneficiary, uint64 unlockAt) external returns (uint256 lockId);
function collectFees(uint256 lockId, address recipient) external returns (uint256 amount0, uint256 amount1);
function extend(uint256 lockId, uint64 unlockAt) external;
function transferBeneficiary(uint256 lockId, address to) external;
function withdraw(uint256 lockId, address recipient) external;
function getLock(uint256 lockId) external view returns (Lock memory);
function isPermanent(uint256 lockId) external view returns (bool);
```

`PERMANENT` is `type(uint64).max` and has no branch that releases it: not for
the beneficiary, not for governance, not after any amount of time. There is no
owner on the locker, so there is nothing to compromise.

`extend` only moves the unlock later, and refuses a permanent lock outright.
`transferBeneficiary` exists because fee rights on a locked position are a real
asset, and forcing them to stay with the launching wallet would mean the only
way to sell them is to not lock in the first place.

**`collectFees` is for concentrated positions only.** A V3-style position
accrues fees separately from its principal, so collecting them is the one value
a lock lets out while it runs. Constant-product LP shares do not work that way:
their fees compound into the reserves the LP balance represents, so a
permanently locked V2 position earns fees nobody can ever withdraw. That is a
property of the AMM rather than of this contract, which is why `collectFees`
reverts on a fungible lock instead of pretending to collect.

## Adapters

An adapter is stateless and holds nothing between calls. The launcher moves the
token to it, calls it once, and the adapter must send the position to the
recipient and return everything unused before it returns. The launcher then
checks that the adapter is empty rather than trusting it to be.

```solidity
function family() external view returns (string memory);
function addLiquidity(AddLiquidityParams calldata params) external payable returns (Position memory);
function validate(bytes calldata config) external view;
```

`validate` runs the same checks the launch path runs, without spending
anything, so a caller can prove their pool configuration is acceptable before
funding a wallet. The V3 adapter's config is a tuple of
`(uint24 fee, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper)`; the V2
adapter takes no configuration at all, because a constant-product pool has none.

Adding an AMM is a new adapter and one `setAdapter` call. Adapters are never
swapped in place: enabling a new one and disabling an old one are separate acts,
and a launch that already happened is unaffected by either.

## Governance

The owner can register or disable an adapter, set a protocol fee up to
`MAX_FEE_BPS` (a constant, one percent, not a setting), and hand ownership over
in two steps.

The owner cannot touch a lock, withdraw anyone's liquidity, change a token that
has launched, raise the fee past the cap, or upgrade any of this. Disabling
every adapter is the worst governance can do, and that stops new launches
without touching old ones.

## Testing

```bash
npm run contracts:simulate                    # deploy and launch against live state
npm run contracts:simulate -- --amm uniswap-v2
npm test                                      # includes the on-chain suite
```

Robinhood Chain serves `eth_simulateV1`, so [the test
suite](../test/contracts.test.js) deploys these contracts on top of the current
block and calls the real factory, the real position manager and the real WETH.
Nothing is signed and no key is needed: the deployer is funded by a state
override that lasts for one RPC call.

Testing a launcher against a mocked AMM proves the mock. The failures that
matter here are the ones only the real deployment produces: a fee tier that is
not enabled, a tick that is not aligned to the spacing the factory actually
returns, a position manager whose mint takes less than it was offered.

## Deploying

```bash
npm run contracts:deploy -- --dry-run    # simulate, price it, write nothing
npm run contracts:deploy -- --confirm    # also needs LAUNCH_RELAY_DEPLOY_KEY
```

The live path needs two keys turned at once and neither works alone. A dry run
executes the identical sequence through the simulator, reports the gas each step
costs and the address each will land at, and fails on anything the live run
would fail on.

Deploying writes
[`deployments.json`](../src/chains/robinhood/deployments.json), which the
library, the CLI and the website all read, so there is one answer to "which
launcher is live" rather than three. Commit it.
