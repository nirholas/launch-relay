# launch-relay

Watch one venue, launch on another, from a pool of wallets.

A coin bonds on pump.fun. Seconds later, a paired token for it exists on
[PAIR](https://pair.fund), deployed from a rotating wallet, priced against the
Robinhood Stock Token that actually fits the coin. That is the flow this tool
automates, and none of it is hardcoded: sources, launchpads, chains, wallet
rotation, filtering, naming, and pairing are all adapters behind one pipeline.

```
pump.fun graduation  ->  rules  ->  spec  ->  wallet  ->  plan  ->  budget  ->  confirm  ->  PAIR launch
     (Solana)                                                                                (Robinhood Chain)
```

**It does not spend money by default.** Dry run is the default mode, live mode
needs a deliberate out-of-band arm, and every launch is priced in full before
anything is signed. See [Safety](#safety).

## Install

```bash
npm install launch-relay
```

Node 20 or newer. `viem` is the only required dependency; `@solana/web3.js` and
`bs58` are optional and load only if you use a Solana wallet pool or the
pump.fun launch target.

## Quick start

Three commands, in this order. Do not skip ahead.

```bash
# 1. Prove the wiring: launchpad reachable, wallets loaded, feed alive.
npx launch-relay doctor

# 2. Watch real graduations flow past your rules, and see what each would become.
npx launch-relay feed --limit 20

# 3. Run the entire pipeline without signing anything.
npx launch-relay run --once
```

`doctor` needs wallets, so set a seed phrase first:

```bash
export LAUNCH_RELAY_MNEMONIC="your twelve or twenty four words"
```

Output from step 2, against the live feed:

```
PASS  CAKE         $639,433     70s ago    Cheesecake
      -> Cheesecake (CAKE)
PASS  ANSEM        $833,064     229s ago   The Black Bull
      -> The Black Bull (ANSEM)
skip  Reptile      $15          353s ago   Reptilian's
      market cap 14.74usd < 30000usd
```

And a priced plan from `npx launch-relay plan`:

```
  LAUNCH PLAN
  ------------------------------------------------------------------
  launchpad   PAIR V5 0x8660A7F019C7943b0b0A91B8E39AFf3b6DB6Ae62 on Robinhood Chain (chain 4663)
  token       Cybertruck Guy (ROBO), fixed supply 1,000,000,000
  pools       TSLA 100.00%
  why         matched TSLA (tesla/elon/cybertruck)
  from wallet 0x2085...f956 (hd-0)
  launch fee  0.0005 ETH
  gas budget  0.000326968 ETH
  total       0.000826968 ETH
  dev buy     none
  origin      pumpfun-graduations 7kSxtYRBogvkk51Y59vV8ygXHWyeNReub4xu6SDpump
  ------------------------------------------------------------------
```

## Safety

An autonomous launcher is a program holding a private key in a loop. The
interesting question is not whether it can launch, it is what stops it. These
are the stops, and they are independent of each other on purpose.

**Dry run is the default.** Every command runs in dry-run mode unless you pass
`--live`. A dry run does every read, every rule check, every simulation, and
prices the launch exactly. It uploads nothing and signs nothing.

**Live mode needs two separate keys turned at once.**

1. `LAUNCH_RELAY_ARMED=1` in the environment. Deliberate, out of band, and
   absent by default, so no config file or stray flag can enable spending.
2. Approval per launch. Interactively that is typing `yes` at a prompt showing
   the wallet, the contract, the pools, and the total cost. Unattended it is
   `--yes`, which is you pre-authorizing every launch the budget permits. In
   that mode the budget caps are the real limit, so set them.

**The budget is enforced before signing, not after.** Launches per hour, per
day, and per wallet per day; cooldowns between launches globally and per wallet;
a maximum spend per launch and per day; a reserve balance every wallet keeps;
and a kill-switch file that halts everything while it exists.

```json
{
  "budget": {
    "maxLaunchesPerHour": 2,
    "maxLaunchesPerDay": 8,
    "maxLaunchesPerWalletPerDay": 3,
    "cooldownMs": 60000,
    "walletCooldownMs": 300000,
    "maxSpendPerLaunch": "0.005",
    "maxSpendPerDay": "0.03",
    "minWalletReserve": "0.002",
    "killSwitchFile": "./HALT"
  }
}
```

```bash
touch ./HALT   # every further launch stops at the budget check, immediately
```

**Rules fail closed.** A threshold whose input could not be read rejects the
signal. A coin whose market cap is unknown is not "under the cap", it is
unknown, and a bound that silently stops applying is worse than no bound.

**Nothing launches twice.** The ledger persists dedupe keys to disk, so a
restart resumes instead of replaying.

**What it plans is what it signs.** Planning produces a priced object; the
executor sends exactly that and refuses a plan priced for a different wallet or
one whose deadline has passed. It re-simulates immediately before signing, so a
launch that would revert costs nothing.

## How a launch is decided

```
signal ─→ dedupe ─→ rules ─→ map ─→ ticker ─→ wallet ─→ plan ─→ budget ─→ confirm ─→ execute ─→ ledger
          cheap ────────────────────────────────→ network ───────────→ human ────→ irreversible
```

Cheap and local first, expensive and irreversible last. Dedupe and rules cost
nothing and reject most of the firehose. Planning costs network calls, an
artwork mirror, and a metadata upload. Only the last stage spends.

## Sources

### `pumpfun-graduations`

Emits a signal the moment a coin's bonding curve fills on pump.fun. Catching
that late is the whole failure mode, so it runs three independent rungs at once
and deduplicates across them:

| Rung | What | Why it is there |
|---|---|---|
| SSE | `three.ws/api/pump/live-stream?kind=graduation` | Enriched events pushed the instant the migration lands |
| WebSocket | `wss://pumpportal.fun/api/data`, `subscribeMigration` | The same upstream, subscribed directly, so one operator's outage is not yours |
| HTTP backfill | `three.ws/api/pump/recent-graduations` | The net: catches whatever both sockets dropped, including everything that happened during a restart |

Rungs disagree about how much they know. PumpPortal sends a mint and nothing
else; the backfill sends a full row, except when the migration is seconds old
and enrichment has not landed. Anything thin gets one lookup against pump.fun,
because rules read market cap and artwork, and a rule that rejects on a missing
field would filter out exactly the freshest graduations.

```json
{
  "source": {
    "type": "pumpfun-graduations",
    "stream": true,
    "pumpPortal": true,
    "backfill": true,
    "pollIntervalMs": 20000,
    "emitBacklog": false
  }
}
```

`emitBacklog` is false by default: the first page after start is history, not
news, so it seeds the dedupe set instead of firing.

### `manual`

The same pipeline fed by hand. For launching one coin with the relay's wallet
rotation and guards, replaying a dropped signal, or testing rules against a
fixture.

## Targets

### `pairfund` (PAIR on Robinhood Chain, EVM, chain 4663)

One transaction deploys a fixed-supply ERC-20 into one to five permanently
locked Uniswap V4 pools, each paired with a Robinhood Stock Token.

| | |
|---|---|
| Launchpad | `0x8660A7F019C7943b0b0A91B8E39AFf3b6DB6Ae62` (V5 proxy) |
| Call | `launchTokenMulti((name, symbol, metadataURI, metadataHash, allocations[], creatorFeeRecipient, developerBuyRecipient, developerBuyPairIndex, developerTokenAmountOut, maxQuoteAmountIn, deadline))` |
| Launch fee | Read from `launchFeeWei()` at plan time, never assumed |
| Cost per launch | The fee plus gas. Currently about 0.0008 ETH all in |
| Supply | Fixed 1,000,000,000, split across the pools by weight |
| Developer buy | Off by default (see below) |

Metadata is mirrored onto PAIR's own host before launch: artwork lives on IPFS
gateways that go down, and a token whose logo 404s in six months looks
abandoned. The on-chain `metadataHash` is the keccak of the exact bytes
uploaded, serialized once and used for both, so the commitment can never point
at a document that does not match.

The **developer buy** is off by default and deliberately so. It requires the
launching wallet to already hold the stock token and to have approved the
launchpad to spend it, which is a much larger commitment than paying a flat fee
to deploy. Turn it on per launch through a mapper hint:

```js
mapper: {
  hints: () => ({ devBuy: { pairIndex: 0, tokenAmountOut: 5_000_000n * 10n ** 18n, maxQuoteIn: 10n ** 18n } }),
}
```

`maxQuoteIn` is a hard ceiling, not a quote. Unused input is never touched.

### `pumpfun` (Solana)

The second target exists to prove the first one is not the architecture. A
different chain, a different fee model, a different metadata host, and a
transaction the venue builds and partial-signs for us rather than one we encode,
all behind the same `plan` and `execute`.

Cost there is measured, not estimated: the transaction is simulated and the
payer's post-transaction lamports are read back, so rent for the accounts a
launch creates is included rather than quietly omitted from a fee estimate.

## Pairing markets

This is the decision PAIR has that other launchpads do not, and it is where the
relay earns its keep. The pairing is launch liquidity, not backing, but it is
also the coin's identity on the platform: a dog coin paired against SGOV reads
as noise, and the same coin paired against TSLA reads as a joke someone gets.

| Strategy | Picks |
|---|---|
| `thematic` | Reads the coin's own name, ticker, and description and pairs it with the market it is about. Falls back when nothing scores |
| `fixed` | Exactly the markets you name, with optional explicit weights |
| `least-crowded` | The markets with the fewest existing launches |
| `popular` | The markets with the most |
| `random` | Uniform over enabled markets |

```
Cybertruck Guy      -> TSLA 100%      matched TSLA (tesla/elon/cybertruck)
AGI Doomer          -> NVDA 100%      matched NVDA (nvidia/gpu/inference)
Apple Vision Pro    -> AAPL 100%      matched AAPL (apple/iphone/vision pro)
Cheesecake          -> NVDA 50% TSLA 50%   no theme matched, fallback markets
```

Matching is whole-word and score-gated. Substring matching pairs a cartoon
seagull with TSLA because "cartoon" contains "car", and a single generic
keyword buried in a description is a coincidence, not a theme: a market must be
named in the coin's name or ticker, or referenced repeatedly, to win a pool.
Tune with `minThemeScore`, or add your own associations:

```js
import { MARKET_THEMES, createMarketSelector } from 'launch-relay';

const selector = createMarketSelector({
  strategy: 'thematic',
  count: 2,
  themes: { ...MARKET_THEMES, NVDA: [...MARKET_THEMES.NVDA, 'datacenter', 'h100'] },
});
```

Weights always total exactly 10000 basis points, which the contract requires.
Three markets become 3334/3333/3333.

## Rules

Rules run before any network call. Every rejection carries a reason, so a dry
run tells you which filter is starving the relay instead of leaving you to
guess.

```json
{
  "rules": {
    "kinds": ["graduation"],
    "minMarketCapUsd": 40000,
    "maxMarketCapUsd": null,
    "minAthMarketCapUsd": null,
    "maxSignalAgeSeconds": 300,
    "maxAssetAgeSeconds": null,
    "minReplyCount": null,
    "maxCreatorLaunches": 5,
    "requireImage": true,
    "requireSocials": "none",
    "denyWords": ["rug", "test"],
    "symbolAllow": [],
    "symbolDeny": ["^TEST"],
    "creatorDeny": []
  }
}
```

`requireSocials` accepts `"none"`, `"any"`, or `"twitter"`. For anything the
schema does not cover, pass a predicate:

```js
rules: {
  custom: async (signal) => (signal.raw.nsfw ? 'flagged nsfw upstream' : null),
}
```

Return a rejection reason, or `null` to pass.

## Naming the relayed coin

```json
{
  "mapper": {
    "nameTemplate": "{{name}}",
    "symbolTemplate": "{{symbol}}",
    "descriptionTemplate": "{{description}}",
    "attributionTemplate": "Relayed by launch-relay after {{symbol}} bonded on {{sourceChain}} {{sourceVenue}}. Origin: {{address}}",
    "carryImage": true,
    "carryLinks": true
  }
}
```

Available placeholders: `name`, `symbol`, `description`, `address`, `creator`,
`source`, `sourceChain`, `sourceVenue`, `url`, `marketCapUsd`. Unknown keys
collapse to an empty string rather than rendering literally, so a typo yields a
short name instead of a token called `SOL {{nmae}}`.

Provenance is not optional. Every launch records where it came from, and the
default description says so, so a relayed token is never presented as an
original launch. Set `attributionTemplate` to `null` to drop the line; the
`origin` record stays either way.

Tickers are sanitized to `A-Z0-9` and checked against the launchpad before
launch. `POPPY` taken becomes `POPPY2`; a limit-length ticker shrinks its stem
to fit the suffix. If the availability check itself fails, the relay logs that
the ticker is unverified and proceeds rather than stalling on an outage.

## Wallets

"From different wallets" is the point of a pool, so rotation is a first-class,
pure decision rather than an index counter.

| Strategy | Behavior |
|---|---|
| `round-robin` | Even distribution across the pool (default) |
| `least-recently-used` | The coldest wallet |
| `least-used` | Fewest launches, ties broken on staleness |
| `richest` | Largest balance |
| `random` | Uniform |
| `sticky` | Always the first eligible wallet |

Three ways to hold keys, all EVM:

```bash
# One seed, N derived accounts. One secret to back up, addresses recoverable
# in any wallet app. This is the default.
LAUNCH_RELAY_MNEMONIC="..."     # with "wallets": { "count": 5 } in the config

# Existing funded keys.
LAUNCH_RELAY_EVM_KEYS=0xabc...,0xdef...

# A key file, kept out of the process environment.
LAUNCH_RELAY_KEYFILE=/secure/keys.json
```

Solana pools take base58 secret keys or 64-byte JSON arrays via
`LAUNCH_RELAY_SOLANA_KEYS` or `LAUNCH_RELAY_SOLANA_KEYFILE`.

Balances are read live for every candidate at pick time. A pool whose first
wallet is empty falls through to the next rather than failing the launch, and a
wallet whose balance cannot be read is skipped: an RPC that will not answer is
not proof the wallet is empty, but it is proof we should not spend from it right
now.

## CLI

```
launch-relay doctor                 Check the target, wallets, and feed
launch-relay wallets                List the pool with live balances
launch-relay markets                List the launchpad's pairing markets
launch-relay feed [--limit n]       Recent signals and how the rules judge each
launch-relay plan [--mint <addr>]   Build and price one launch without sending
launch-relay run [--once]           Run the relay
launch-relay ledger [--limit n]     Recent ledger records

  --config <path>   Config file. Defaults to ./launch-relay.config.json
  --live            Spend real funds. Requires LAUNCH_RELAY_ARMED=1
  --yes             Pre-approve every launch the budget permits
  --debug           Verbose logging
```

```bash
# Unattended, live, inside the budget:
LAUNCH_RELAY_ARMED=1 launch-relay run --live --yes

# Live with a human at the keyboard confirming each launch:
LAUNCH_RELAY_ARMED=1 launch-relay run --live
```

## Library

```js
import { presets } from 'launch-relay';

const { relay } = await presets.pumpfunToPairfund({
  mnemonic: process.env.LAUNCH_RELAY_MNEMONIC,
  wallets: 3,
  rules: { minMarketCapUsd: 40_000 },
  markets: { strategy: 'thematic', count: 2 },
  budget: { maxLaunchesPerDay: 8, maxSpendPerDay: '0.03' },
});

relay.start();
```

Or wire it yourself. The preset composes nothing you cannot:

```js
import {
  createRelay, createPumpFunGraduationSource, createPairFundTarget,
  createEvmWalletPool, createFileStore,
} from 'launch-relay';

const target = createPairFundTarget({ marketSelector: { strategy: 'least-crowded', count: 3 } });
const relay = createRelay({
  sources: [createPumpFunGraduationSource()],
  target,
  wallets: await createEvmWalletPool({ chain: target.viemChain, mnemonic, count: 5, strategy: 'least-used' }),
  store: await createFileStore('.ledger'),
  mode: 'live',
  confirm: async (plan) => myApprovalQueue.ask(plan),
});
```

### Writing a source

Implement `start` for a push feed or `poll` for anything listable. Signals are
plain objects; see `src/types.js` for the full shape.

```js
const source = {
  id: 'my-feed',
  chain: 'base',
  pollIntervalMs: 30_000,
  async poll() {
    return [{
      id: 'my-feed:0x123',        // stable dedupe key
      source: 'my-feed',
      kind: 'graduation',
      chain: 'base',
      at: Date.now(),
      address: '0x123',
      name: 'Some Coin',
      symbol: 'SOME',
      description: 'why it matters',
      imageUrl: 'https://example.com/logo.png',
      links: { twitter: null, telegram: null, website: null },
      metrics: { marketCapUsd: 50_000 },
    }];
  },
};
```

### Writing a target

Two methods. `plan` does every read, upload, and simulation and returns a
priced object. `execute` signs exactly that. Keeping them separate is what
lets a human see the real cost of the real transaction before it exists.

```js
const target = {
  id: 'my-launchpad',
  chain: 'base',
  chainId: 8453,
  nativeSymbol: 'ETH',
  nativeDecimals: 18,
  async symbolTaken(symbol) { /* optional collision check */ },
  async plan(spec, { wallet, log, dryRun }) { /* returns a LaunchPlan */ },
  async execute(plan, { wallet, log }) { /* returns { ok, txHash, tokenAddress, url } */ },
};
```

`examples/custom-source-and-target.mjs` is a runnable version of both.

## The ledger

Two append-only JSONL files under `store.dir` (default `.ledger/`):

- `seen.jsonl` is the dedupe set, which is what makes a restart resume instead
  of replay.
- `launches.jsonl` is one record per planned, declined, failed, or executed
  launch, with the wallet, the cost, the transaction, and the origin signal.

JSONL because it is the audit trail for money that moved: appends are atomic
enough at these sizes, a truncated final line costs one record rather than the
file, and `tail -f` is a working live view.

```bash
launch-relay ledger --limit 20
tail -f .ledger/launches.jsonl
```

## Development

```bash
npm install
npm test          # 129 tests, no network
node bin/launch-relay.js doctor
```

Tests cover the pure decision layers (rules, budget, rotation, market
selection, naming, normalization) and the adapter behavior that matters most
(metadata hashing, plan and execute refusals, dedupe across restarts, the full
engine pipeline in both modes). Nothing in the suite touches a chain or spends
anything.

## Disclaimer

This tool signs blockchain transactions that cannot be reversed. Launching a
token is a public, permanent act with legal and financial consequences that
vary by jurisdiction. You are responsible for what your keys do, for the
content of what you launch, and for anyone who buys it. Relaying someone else's
coin creates a distinct token that is not affiliated with, endorsed by, or
redeemable against the original; the default attribution line exists so that
stays clear to everyone who sees it.

Nothing here is financial advice. Read the code before you arm it.

## License

Apache-2.0
