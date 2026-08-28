# launch-relay

**Watch one venue, launch on another, from a pool of wallets.** With a backtester
that refuses to lie to you, and an approval flow that lets a bot run unattended
without handing it a blank cheque.

A coin bonds on pump.fun. Seconds later a paired token for it exists on
[PAIR](https://pair.fund), deployed from a rotating wallet, priced against the
Robinhood Stock Token that actually fits the coin, with a launch plan that a
human approved from their phone. None of that is hardcoded: sources, launchpads,
chains, rotation, filtering, naming, and pairing are all adapters behind one
pipeline.

```
pump.fun graduation ─→ rules ─→ spec ─→ wallet ─→ plan ─→ budget ─→ approval ─→ PAIR launch
    (Solana)                                                          (phone)    (Robinhood Chain)
```

**It does not spend money by default.** Dry run is the default mode, live mode
needs a deliberate out-of-band arm, and every launch is priced in full before
anything is signed. See [Safety](#safety).

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Backtest before you fund anything](#backtest-before-you-fund-anything)
- [Approve from your phone](#approve-from-your-phone)
- [The dashboard](#the-dashboard)
- [Safety](#safety)
- [How a launch is decided](#how-a-launch-is-decided)
- [Sources](#sources)
- [Targets](#targets)
- [Pairing markets](#pairing-markets)
- [Rules](#rules)
- [Naming the relayed coin](#naming-the-relayed-coin)
- [Wallets](#wallets)
- [Creator fees and portfolio](#creator-fees-and-portfolio)
- [CLI](#cli)
- [SDK](#sdk)
- [The ledger](#the-ledger)
- [Development](#development)

---

## Install

```bash
npm install launch-relay
```

Node 20 or newer. `viem` is the only required dependency. `@solana/web3.js` and
`bs58` are optional and load only if you use a Solana wallet pool or the
pump.fun launch target. TypeScript declarations ship in the package.

## Quick start

Four commands, in this order. Do not skip ahead.

```bash
export LAUNCH_RELAY_MNEMONIC="your twelve or twenty four words"

npx launch-relay doctor                # prove the wiring
npx launch-relay backtest --limit 500  # prove the rules against real history
npx launch-relay feed --limit 20       # watch live graduations meet your rules
npx launch-relay run --once            # the whole pipeline, signing nothing
```

`feed`, against the live feed:

```
PASS  CAKE         $639,433     70s ago    Cheesecake
      -> Cheesecake (CAKE)
PASS  ANSEM        $833,064     229s ago   The Black Bull
      -> The Black Bull (ANSEM)
skip  Reptile      $15          353s ago   Reptilian's
      market cap 14.74usd < 30000usd
```

`plan`, priced live off the contract:

```
  LAUNCH PLAN
  --------------------------------------------------------------------
  launchpad   PAIR V5 0x8660A7F019C7943b0b0A91B8E39AFf3b6DB6Ae62 on Robinhood Chain (chain 4663)
  token       Cybertruck Guy (ROBO), fixed supply 1,000,000,000
  pools       TSLA 100.00%
  why         matched TSLA (tesla/elon/cybertruck)
  from wallet 0x2085...f956 (hd-0)
  launch fee  0.0005 ETH
  gas budget  0.000149 ETH
  total       0.000649 ETH
  dev buy     none
  origin      pumpfun-graduations 7kSxtYRBogvkk51Y59vV8ygXHWyeNReub4xu6SDpump
  --------------------------------------------------------------------
```

## Backtest before you fund anything

Your rules are a bet. `launch-relay backtest` replays real pump.fun graduations
through the exact same rules, mapper, market selector, and budget the live relay
uses, and tells you what would have happened.

```bash
npx launch-relay backtest --limit 500
```

```
Backtest over 300 pump.fun graduations
2026-08-27 21:05 to 2026-08-28 03:26  (6.4h)

RULES --------------------------------------------------------------
  not testable on historical data, so these were switched off:
    minMarketCapUsd
    maxSignalAgeSeconds
    pump.fun publishes a coin's market cap now and its peak ever,
    both of which are the future relative to the graduation being
    replayed. Feeding either to a rule would select on the answer.

  passed          297  (99.0%)
  rejected          3

BUDGET -------------------------------------------------------------
  would launch     10  of 297 that passed the rules
  throttled       287  by caps and cooldowns
  cost          0.006574718 ETH  (10 x 0.0006574718)
    held back   ECTF: hourly cap reached (3/3)

SELECTION QUALITY --------------------------------------------------
  peak market cap reached after graduation
                          selected       rejected
    sample                      10              3
    median                 $91,366        $35,498
    p75                   $113,166        $40,052
    best                  $134.80M        $44,606

  the selected cohort's median peak is 2.57x the rejected cohort's
  SMALL SAMPLE: 10 selected vs 3 rejected. Directional at best.

  This measures which SOURCE coins the rules picked. It is not a
  return: the relayed token never existed and its price is unknowable.
```

**Read the parts that make it uncomfortable, because they are why it is worth
anything.**

*It disables rules it cannot honestly test.* pump.fun publishes a coin's market
cap *now* and its peak *ever*. Both are the future relative to the graduation
being replayed. Feeding either into a filter is lookahead bias: the filter
selects on the answer and every backtest looks brilliant. So historical signals
carry those numbers in `outcome`, which only the scoring reads, never in
`metrics`, which is what rules read. Rules whose inputs do not survive that
separation are switched off and named in the report.

*It replays the budget chronologically.* Rate limits, cooldowns, and per-wallet
caps are applied in the order the events actually happened, so "my rules liked
60 coins" and "my caps would have let 10 through" stay separate numbers. That
gap is usually the most actionable line in the report.

*It measures selection, not returns.* The relayed token never existed and its
price is unknowable. What is knowable, and checkable, is whether the filter
picked source coins that went on to do better than the ones it discarded. That
is the question that decides whether a rule set is worth funding.

*It warns on thin samples* rather than letting a 7x median lift over three
rejected coins read as a result.

The cost line is priced off the launchpad's `launchFeeWei()` and the current gas
price at the moment you run it, not a constant baked into the source.

## Approve from your phone

This is the piece that makes unattended autonomy defensible. The relay runs
headless on a box somewhere. When a coin clears your rules, your phone buzzes
with the wallet, the pools, and the exact cost. Nothing is signed until you tap
**Approve**.

```bash
export LAUNCH_RELAY_TELEGRAM_TOKEN=...      # from @BotFather
export LAUNCH_RELAY_TELEGRAM_CHAT_ID=...
export LAUNCH_RELAY_TELEGRAM_USER_IDS=...   # only these users may approve

LAUNCH_RELAY_ARMED=1 launch-relay run --live --telegram
```

You get the reaction speed of a bot with the judgment of a person, and the key
never leaves the machine. Three properties this depends on, none optional:

**Fail closed.** A timeout, a dropped connection, a bot that was never started:
every one of them denies. An approval system that defaults to yes when it cannot
reach you is not an approval system.

**Only you can approve.** Callbacks are checked against the configured chat and,
if you set it, a user allowlist. A bot token is a bearer credential and bots get
found. Set `LAUNCH_RELAY_TELEGRAM_USER_IDS` for any group chat.

**One poller.** Telegram's `getUpdates` is a single-consumer queue; two loops on
one token steal each other's updates. The client owns exactly one loop and
dispatches to whoever is waiting.

The chat becomes the audit log: each prompt is edited in place to record
`APPROVED by @you` or `REJECTED (timed out)`, so scrolling back tells you what
happened rather than showing a wall of stale buttons.

Approvers compose. With a terminal attached, `--telegram` requires **both** a tap
and a typed yes, which is the right default for a shared treasury. Headless, it
degrades to Telegram alone rather than refusing to start.

## The dashboard

```bash
launch-relay watch
```

```
launch-relay  pairfund on Robinhood Chain  up 14m
DRY RUN: nothing will be signed
wallets ------------------------------------------------------------
  hd-0    0x9905..66a9 [########..]  0.004821 ETH  2 launch(es)
  hd-1    0x2A7c..Cf6B [####......]  0.002100 ETH  1 launch(es)
  hd-2    0x4617..b61d [..........]         0 ETH  0 launch(es)
budget -------------------------------------------------------------
  launches   2/2 this hour   3/8 today
  spend      0.00195 / 0.03 ETH today   reserve 0.002 per wallet
  halt file  ./HALT
feed ---------------------------------------------------------------
  03:41:02 PLAN   CHARIZARD priced at 0.000649 ETH
  03:40:55 skip   BULLIO: market cap 22529usd < 50000usd
  03:40:31 LAUNCH GOBLIN -> 0x7f3a...c201
```

Four things a scrolling log cannot show at a glance: what the feed is producing,
what the rules are doing to it, what the wallets hold, and how much of the
budget is gone. Zero dependencies, and `q` quits.

## Safety

An autonomous launcher is a program holding a private key in a loop. The
interesting question is not whether it can launch, it is what stops it. These
are the stops, and they are independent of each other on purpose.

**Dry run is the default.** Every command runs in dry-run mode unless you pass
`--live`. A dry run does every read, every rule check, every simulation, and
prices the launch exactly. It uploads nothing and signs nothing. It also still
reports what the budget *would* have done, rather than hiding a launch it would
have blocked, and it prices against your wallets even when they are empty, so
you can evaluate the whole thing before funding anything.

**Live mode needs two separate keys turned at once.**

1. `LAUNCH_RELAY_ARMED=1` in the environment. Deliberate, out of band, and absent
   by default, so no config file or stray flag can enable spending.
2. Approval per launch: a typed `yes` at the terminal, a tap in Telegram, or an
   explicit `--yes` standing authorization bounded by the budget.

**The budget is enforced before signing, not after.**

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

**Claiming and funding ask too.** Every command that produces a transaction
(`claim`, `fund`) renders a plan and waits for a yes, exactly like a launch.

## How a launch is decided

```
signal ─→ dedupe ─→ rules ─→ map ─→ ticker ─→ wallet ─→ plan ─→ budget ─→ approval ─→ execute ─→ ledger
          cheap ──────────────────────────────→ network ──────────→ human ─────────→ irreversible
```

Cheap and local first, expensive and irreversible last. Dedupe and rules cost
nothing and reject most of the firehose. Planning costs network calls, an artwork
mirror, and a metadata upload. Only the last stage spends.

Signals are processed serially. Wallet selection, budget checks, and the daily
spend total all read shared state, and a race between two launches is exactly how
caps get exceeded.

## Sources

### `pumpfun-graduations`

Emits a signal the moment a coin's bonding curve fills. Catching that late is
the whole failure mode, so it runs three independent rungs at once and
deduplicates across them:

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

`emitBacklog` is false by default: the first page after start is history, not
news, so it seeds the dedupe set instead of firing.

### `manual`

The same pipeline fed by hand. For launching one coin with the relay's wallet
rotation and guards, replaying a dropped signal, or testing rules against a
fixture.

## Targets

### `pairfund` (PAIR on Robinhood Chain, EVM, chain 4663)

One transaction deploys a fixed-supply ERC-20 into one to five permanently locked
Uniswap V4 pools, each paired with a Robinhood Stock Token.

| | |
|---|---|
| Launchpad | `0x8660A7F019C7943b0b0A91B8E39AFf3b6DB6Ae62` (V5 proxy) |
| Fee locker | `0xeFcF476E8870fB3eb8680f039414fdcCE6C2a117` (PairV4Locker) |
| Call | `launchTokenMulti((name, symbol, metadataURI, metadataHash, allocations[], creatorFeeRecipient, developerBuyRecipient, developerBuyPairIndex, developerTokenAmountOut, maxQuoteAmountIn, deadline))` |
| Launch fee | Read from `launchFeeWei()` at plan time, never assumed |
| Cost per launch | The fee plus gas. Currently about 0.00065 ETH all in |
| Supply | Fixed 1,000,000,000, split across the pools by weight |
| Developer buy | Off by default |

Metadata is mirrored onto PAIR's own host before launch: artwork lives on IPFS
gateways that go down, and a token whose logo 404s in six months looks
abandoned. The on-chain `metadataHash` is the keccak of the exact bytes uploaded,
serialized once and used for both, so the commitment can never point at a
document that does not match.

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
different chain, fee model, and metadata host, and a transaction the venue builds
and partial-signs for us rather than one we encode, all behind the same `plan`
and `execute`.

Cost there is **measured, not estimated**: the transaction is simulated and the
payer's post-transaction lamports are read back, so rent for the accounts a
launch creates is included rather than quietly omitted from a fee estimate. And
the blockhash is never refreshed, because pump.fun's mint keypair signed over it:
replacing it would invalidate that signature. An expired plan is a re-plan, not a
retry, and it says so.

## Pairing markets

This is the decision PAIR has that other launchpads do not, and it is where the
relay earns its keep. The pairing is launch liquidity, not backing, but it is
also the coin's identity on the platform: a dog coin paired against SGOV reads as
noise, and the same coin paired against TSLA reads as a joke someone gets.

| Strategy | Picks |
|---|---|
| `thematic` | Reads the coin's own name, ticker, and description and pairs it with the market it is about |
| `fixed` | Exactly the markets you name, with optional explicit weights |
| `least-crowded` | The markets with the fewest existing launches |
| `popular` | The markets with the most |
| `random` | Uniform over enabled markets |

```
Cybertruck Guy      -> TSLA 100%            matched TSLA (tesla/elon/cybertruck)
AGI Doomer          -> NVDA 100%            matched NVDA (nvidia/gpu/inference)
Apple Vision Pro    -> AAPL 100%            matched AAPL (apple/iphone/vision pro)
Cheesecake          -> NVDA 50% TSLA 50%    no theme matched, fallback markets
```

Matching is whole-word and score-gated. Substring matching pairs a cartoon
seagull with TSLA because "cartoon" contains "car", and a single generic keyword
buried in a description is a coincidence, not a theme: a market must be named in
the coin's name or ticker, or referenced repeatedly, to win a pool. Tune with
`minThemeScore`, or bring your own associations:

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

Rules run before any network call. Every rejection carries a reason, so a dry run
tells you which filter is starving the relay instead of leaving you to guess.

```json
{
  "rules": {
    "kinds": ["graduation"],
    "minMarketCapUsd": 50000,
    "maxMarketCapUsd": null,
    "minAthMarketCapUsd": null,
    "maxSignalAgeSeconds": 900,
    "maxAssetAgeSeconds": null,
    "minReplyCount": null,
    "maxCreatorLaunches": 5,
    "requireImage": true,
    "requireSocials": "none",
    "denyWords": ["rug", "scam", "test"],
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

Placeholders: `name`, `symbol`, `description`, `address`, `creator`, `source`,
`sourceChain`, `sourceVenue`, `url`, `marketCapUsd`. Unknown keys collapse to an
empty string rather than rendering literally, so a typo yields a short name
instead of a token called `SOL {{nmae}}`.

Provenance is not optional. Every launch records where it came from, and the
default description says so, so a relayed token is never presented as an original
launch. Set `attributionTemplate` to `null` to drop the line; the `origin` record
stays either way.

Tickers are sanitized to `A-Z0-9` and checked against the launchpad before
launch. `POPPY` taken becomes `POPPY2`; a limit-length ticker shrinks its stem to
fit the suffix. If the availability check itself fails, the relay logs that the
ticker is unverified and proceeds rather than stalling on an outage.

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

Three ways to hold keys:

```bash
# One seed, N derived accounts. One secret to back up, addresses recoverable in
# any wallet app. This is the default.
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

Level the pool from whichever wallet you funded:

```bash
launch-relay fund --target 0.01
```

```
  FUNDING PLAN
  --------------------------------------------------------------------
  source      0x9905..66a9 (hd-0) holding 0.05 ETH
  target      0.01 ETH in each of 2 other wallet(s)
  transfers   2: hd-1 +0.01, hd-2 +0.008
  total       0.018 ETH, keeping 0.002 ETH as gas reserve
  --------------------------------------------------------------------
  send these transfers? type yes to sign:
```

## Creator fees and portfolio

Every PAIR token pays its creator a share of swap fees. Those fees do not arrive
in a wallet: they accumulate inside the locked Uniswap V4 position, get swept by
PAIR's keeper roughly hourly, and sit in a locker until claimed. **An autonomous
launcher that never claims is leaving its own revenue on the floor**, which is
why this is part of the tool rather than an afterthought.

```bash
launch-relay fees      # what is claimable now, and what is still pending a sweep
launch-relay claim     # claim it, one transaction per asset, after you say yes
launch-relay positions # everything you launched, with live market data
```

```
3 launch(es) from 2 wallet(s), 0.00195 ETH spent

symbol          market cap    liquidity         cost pools          status
------------------------------------------------------------------------------
GOBLIN             $18,400       $2,140      0.000649 NVDA/TSLA     12.0% to milestone
CHARIZARD           $9,120         $980      0.000651 SPCX          4.0% to milestone
PEPE2                    -            -      0.000650 AAPL          not indexed
------------------------------------------------------------------------------
total              $27,520       $3,120      0.00195

FEES
  claimable   2107.495294 DOGE
  pending     1 position(s) awaiting the keeper sweep
  Fees accrue in the pool asset, not ETH. USD figures appear only where PAIR priced them.
```

Two deliberate refusals in that report. A token the launchpad no longer indexes
is **kept and flagged**, not dropped: a launch that cost money and then vanished
from an index is the most important row on the page. And there is no single
"profit" number, because fees accrue in stock tokens and project tokens whose USD
value PAIR does not always price. A made-up conversion would be the most quoted
and least true line in the tool.

Claiming is a real transaction from your key, so it renders a plan and asks
first, exactly like a launch. It runs one transaction per asset and **does not
stop the batch when one fails**: an asset whose balance moved under the API's
cached view should not cost you the other three.

## CLI

```
Prove it
  doctor                    Check target, wallets, feed, and notification channels
  backtest [--limit n]      Replay real graduations through your rules
  feed [--limit n]          Recent signals and how the rules judge each one
  plan [--mint <addr>]      Build and price one launch without sending it
  markets                   List the launchpad's pairing markets

Run it
  run [--once]              Run the relay
  watch                     Run with a live dashboard

Own it
  positions                 Portfolio with live market data
  fees                      Claimable and pending creator fees
  claim                     Claim creator fees (on-chain, asks first)
  fund --target <amount>    Level every wallet in the pool
  ledger [--limit n]        Recent ledger records

  --config <path>   Config file. Defaults to ./launch-relay.config.json
  --live            Spend real funds. Requires LAUNCH_RELAY_ARMED=1
  --yes             Standing approval for every launch the budget permits
  --telegram        Approve each launch from Telegram
  --json            Machine-readable output where supported
  --debug           Verbose logging
```

```bash
# Unattended, live, approved from a phone:
LAUNCH_RELAY_ARMED=1 launch-relay run --live --telegram

# Unattended, live, bounded only by the budget:
LAUNCH_RELAY_ARMED=1 launch-relay run --live --yes

# Live with a human at the keyboard:
LAUNCH_RELAY_ARMED=1 launch-relay run --live
```

## SDK

Typed, tree-shakeable, and every piece the preset composes is exported.

```ts
import { presets } from 'launch-relay';

const { relay } = await presets.pumpfunToPairfund({
  mnemonic: process.env.LAUNCH_RELAY_MNEMONIC,
  wallets: 3,
  rules: { minMarketCapUsd: 50_000 },
  markets: { strategy: 'thematic', count: 2 },
  budget: { maxLaunchesPerDay: 8, maxSpendPerDay: '0.03' },
});

relay.start();
```

Wire it yourself, with approval routed anywhere you like:

```ts
import {
  createRelay, createPumpFunGraduationSource, createPairFundTarget,
  createEvmWalletPool, createFileStore, createTelegramClient, createTelegramApproval,
} from 'launch-relay';

const target = createPairFundTarget({ marketSelector: { strategy: 'least-crowded', count: 3 } });
const telegram = createTelegramClient({ token, chatId, allowedUserIds: ['12345'] });

const relay = createRelay({
  sources: [createPumpFunGraduationSource()],
  target,
  wallets: await createEvmWalletPool({ chain: target.viemChain, mnemonic, count: 5, strategy: 'least-used' }),
  store: await createFileStore('.ledger'),
  mode: 'live',
  confirm: createTelegramApproval({ client: telegram }),
});
```

### Writing a source

Implement `start` for a push feed or `poll` for anything listable.

```ts
const source: Source = {
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

Two methods. `plan` does every read, upload, and simulation and returns a priced
object. `execute` signs exactly that. Keeping them separate is what lets a human
see the real cost of the real transaction before it exists.

```ts
const target: Target = {
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

- `seen.jsonl` is the dedupe set, which is what makes a restart resume instead of
  replay.
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
npm test          # 202 tests, no network, nothing spent
npm run typecheck # index.d.ts against tsc
node bin/launch-relay.js doctor
```

Tests cover the pure decision layers (rules, budget, rotation, market selection,
naming, normalization, backtest scoring) and the adapter behavior that matters
most: metadata hashing, plan and execute refusals, dedupe across restarts, fee
claim batching, funding shortfalls, the full engine pipeline in both modes, and
every failure mode of the Telegram approver (wrong chat, unauthorized user, stale
nonce, timeout, transport error, all denying).

## Disclaimer

This tool signs blockchain transactions that cannot be reversed. Launching a
token is a public, permanent act with legal and financial consequences that vary
by jurisdiction. You are responsible for what your keys do, for the content of
what you launch, and for anyone who buys it. Relaying someone else's coin creates
a distinct token that is not affiliated with, endorsed by, or redeemable against
the original; the default attribution line exists so that stays clear to everyone
who sees it.

The backtester measures selection over a short historical window and says so.
Nothing here is financial advice. Read the code before you arm it.

## License

Apache-2.0
