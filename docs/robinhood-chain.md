# Robinhood Chain

Everything this toolkit knows about the network, where each fact came from, and
how to check it yourself.

Robinhood Chain is an EVM network, chain id **4663**, settling gas in ETH.

| | |
| --- | --- |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Native currency | ETH, 18 decimals |

Override the RPC with `LAUNCH_RELAY_RPC_URL`. The public endpoint rate-limits
hard, which is survivable for a launch and painful for a catalog rebuild.

## Assets

| Symbol | Address | Decimals | What it is |
| --- | --- | --- | --- |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 18 | Wrapped ETH |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | **6** | Global Dollar, the dominant stable quote |
| VIRTUAL | `0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31` | 18 | Virtuals Protocol, quote asset for every agent token launched on its curve |

USDG having six decimals rather than eighteen is the single most common source
of a wrong pool price on this chain. The pool math takes base units precisely so
the difference cannot be introduced by accident.

Beyond these, the chain carries a large universe of tokenized stocks. Any of
them can be a pool quote, and the PAIR launchpad pairs against them by design.

## Infrastructure

| | Address | How it was identified |
| --- | --- | --- |
| Uniswap V2 factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` | `allPairsLength()` returns a five-figure pair count |
| Uniswap V2 router | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` | `factory()` and `WETH()` both match the entries here |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | emitter of almost every `PoolCreated` log on the chain |
| Uniswap V3 positions | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | `name()` is "Uniswap V3 Positions NFT-V1"; `factory()` matches |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | sole emitter of V4 `Initialize` logs |
| Uniswap V4 positions | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | `name()` is "Uniswap v4 Positions NFT"; `poolManager()` and `permit2()` match |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical address, non-empty bytecode |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | canonical address |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | canonical address; some launches arrive as user operations through it |

V3 fee tiers, read back one at a time from `feeAmountTickSpacing()`:

| Fee | Tick spacing |
| --- | --- |
| 100 (0.01%) | 1 |
| 500 (0.05%) | 10 |
| 3000 (0.30%) | 60 |
| 10000 (1%) | 200 |

Several V2 and V3 forks also run here and implement the same interfaces
unchanged. They are listed in `AMM_FORKS` and any of them can be used by passing
`factory` to `createPoolLaunchTarget`.

**None of this is taken on trust.** Every address above is re-derived from live
state by:

```bash
npm run rhc:verify
```

which exits non-zero on a mismatch. An address book is the most dangerous file
in a program that spends money, so it is the one file here that proves itself
on demand.

## Venues

Launchpads are not pinned by hand. They are discovered:

```bash
npm run rhc:discover -- --blocks 200000              # rescan, relearn, re-probe
npm run rhc:discover -- --cache .cache/scan.json     # reuse the last scan
npm run rhc:discover -- --no-simulate                # skip the probe
npx launch-relay venues
```

The probe runs by default and is the part worth paying for. For each venue it
builds the launch you would build, with a fresh name, symbol and salt, and
executes it against current chain state from a probe address funded by a state
override. Nothing is signed and no funds are needed.

It adds one binding at a time, so the result is not what inference guessed but
what the contract accepted. A field the venue refuses is pruned back to being
replayed, with the revert that pruned it recorded, and a venue that will not
take a launch at all says so in the catalog with the custom error it reverted
with.

`--no-simulate` skips it. The catalog still builds, and its bindings are then
inferences rather than proofs.

The generated catalog lives at
[`src/chains/robinhood/venues/catalog.json`](../src/chains/robinhood/venues/catalog.json)
and the current contents are rendered in [venues.md](venues.md). The method,
and the guarantees it does and does not give, are in the README under
[The venue catalog](../README.md#the-venue-catalog).

### Adding or refreshing a venue

You do not write an adapter. You point discovery at the chain.

1. **If the venue launched recently**, widen the scan until it is inside the
   window: `npm run rhc:discover -- --blocks 400000`.
2. **If it launched a while ago**, add one of its real launch transaction
   hashes to
   [`src/chains/robinhood/venues/seeds.json`](../src/chains/robinhood/venues/seeds.json)
   and rerun. Seeds pin a venue into the catalog without widening the scan to
   the whole chain. Several hashes for the same venue is better than one,
   because the launch fee is taken as the floor across everything observed.
3. **Check what it learned**: `npx launch-relay venue <id>`. It prints the
   signature, which fields it will fill in, the anchor transaction it learned
   from, and whether a launch on it works right now. A field shown as replayed
   is one the live probe found the venue will not let a launch change, which is
   usually a commitment hash rather than a free parameter; the revert that
   pruned it is recorded beside it.
4. **If a field it replays should be yours to set**, add an entry to
   [`src/chains/robinhood/venues/overrides.js`](../src/chains/robinhood/venues/overrides.js)
   with the path, the role, and the evidence for the claim. Evidence means a
   decoded transaction or a published interface. An override that breaks the
   descriptor's ability to reproduce its own anchor is rejected automatically.
5. **Run the tests.** `npm test` asserts that every launchable venue in the
   catalog reproduces its anchor calldata byte for byte.

### When a selector cannot be named

Discovery still publishes the venue, marked unusable, with the reason. That is
deliberate: a launchpad this toolkit cannot drive is still a fact about the
chain, and a silent omission looks identical to a venue that does not exist.

If you can name the selector, pass it through `lookupSignatures`' `overrides`
argument, or get the contract verified so the Openchain database picks it up and
every user of this toolkit benefits rather than just you.

## Calls that arrive through something else

Three contracts show up as the transaction target without being launchpads:
ERC-4337's EntryPoint, Multicall3, and the CREATE3 deployer. A launch routed
through one of them names the forwarder, not the venue. Discovery marks these
and does not publish them as venues, because the launchpad is inside the inner
call rather than at the address that was called.

## See also

- [contracts.md](contracts.md) — the Relay protocol: what it deploys, what it guarantees, how to test and deploy it.
- [venues.md](venues.md) — the current catalog, rendered.
