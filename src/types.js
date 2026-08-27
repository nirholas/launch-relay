// Adapter contracts for @three-ws/launch-relay.
//
// The relay is four swappable pieces joined by two plain objects. A Source
// emits Signals, a Mapper turns a Signal into a LaunchSpec, a Target turns a
// LaunchSpec into an on-chain launch, and a WalletPool decides which key pays
// for it. Nothing here imports a chain library, which is why the same engine
// drives an EVM launchpad and a Solana one without branching.

/**
 * A thing that happened somewhere else and might be worth launching a coin
 * about. Sources normalize their upstream payload into this shape so rules and
 * mappers never learn a venue's field names.
 *
 * @typedef {object} Signal
 * @property {string} id            Stable dedupe key, unique per source (a mint address, a tx signature).
 * @property {string} source        Source id that produced it ('pumpfun-graduations').
 * @property {string} kind          What happened ('graduation', 'launch', 'manual').
 * @property {string} chain         Chain the event happened on ('solana').
 * @property {number} at            Event time, epoch ms.
 * @property {string} [name]        Human name of the originating asset.
 * @property {string} [symbol]      Ticker of the originating asset.
 * @property {string} [description]
 * @property {string} [imageUrl]
 * @property {string} [address]     On-chain address of the originating asset (mint / contract).
 * @property {string} [creator]     Address that created the originating asset.
 * @property {string} [url]         Canonical human URL for the event.
 * @property {{twitter?: string|null, telegram?: string|null, website?: string|null}} [links]
 * @property {SignalMetrics} [metrics]
 * @property {object} [raw]         Untouched upstream payload, for rules that need a field we did not normalize.
 */

/**
 * Numbers rules filter on. Every field is optional: a source that cannot
 * resolve one leaves it null rather than guessing, and a rule that needs a
 * null field fails closed.
 *
 * @typedef {object} SignalMetrics
 * @property {number|null} [marketCapUsd]
 * @property {number|null} [athMarketCapUsd]
 * @property {number|null} [liquiditySol]
 * @property {number|null} [ageSeconds]        Age of the originating asset at signal time.
 * @property {number|null} [creatorLaunches]   How many coins this creator has launched before.
 * @property {number|null} [replyCount]
 */

/**
 * What to launch, in venue-neutral terms. Produced by a mapper, consumed by a
 * target. `targetHints` is the one place a spec may carry venue-specific
 * intent; a target ignores hints it does not understand.
 *
 * @typedef {object} LaunchSpec
 * @property {string} name
 * @property {string} symbol
 * @property {string} description
 * @property {string|null} imageUrl     Remote image the target mirrors into its own metadata host.
 * @property {{twitter?: string|null, telegram?: string|null, website?: string|null}} links
 * @property {{source: string, chain: string, address?: string|null, url?: string|null, signalId: string}} origin
 * @property {object} [targetHints]
 */

/**
 * A priced, fully-prepared launch that has not been signed yet. `execute`
 * turns exactly this into a transaction, so whatever a confirmation prompt
 * renders is what gets signed.
 *
 * @typedef {object} LaunchPlan
 * @property {string} target            Target id.
 * @property {string} chain             Chain the transaction lands on.
 * @property {number} chainId           Numeric chain id where the concept applies, else 0.
 * @property {LaunchSpec} spec
 * @property {string} wallet            Address that signs and pays.
 * @property {string} contract          Contract or program the transaction calls.
 * @property {{nativeSymbol: string, feeNative: string, gasNative: string, totalNative: string}} cost
 * @property {string[]} warnings
 * @property {object} call              Target-private payload consumed by `execute`.
 * @property {string[]} summary         Human lines rendered by the confirmation prompt.
 */

/**
 * @typedef {object} LaunchResult
 * @property {boolean} ok
 * @property {string} [txHash]
 * @property {string} [tokenAddress]
 * @property {string} [url]
 * @property {string} [error]
 */

/**
 * Event producer. Push sources implement `start`; pull sources implement
 * `poll`. Implement whichever fits the upstream and the engine adapts: it
 * polls `poll` on an interval and subscribes once to `start`.
 *
 * @typedef {object} Source
 * @property {string} id
 * @property {string} chain
 * @property {(onSignal: (s: Signal) => void, opts: {signal: AbortSignal, log: Logger}) => (() => void)|Promise<() => void>} [start]
 * @property {(opts: {log: Logger}) => Promise<Signal[]>} [poll]
 * @property {number} [pollIntervalMs]
 */

/**
 * Launchpad adapter.
 *
 * @typedef {object} Target
 * @property {string} id
 * @property {string} chain
 * @property {number} chainId
 * @property {string} nativeSymbol
 * @property {(spec: LaunchSpec, ctx: {wallet: WalletHandle, log: Logger}) => Promise<LaunchPlan>} plan
 * @property {(plan: LaunchPlan, ctx: {wallet: WalletHandle, log: Logger}) => Promise<LaunchResult>} execute
 * @property {(symbol: string) => Promise<boolean>} [symbolTaken]
 * @property {() => Promise<{ok: boolean, detail: string}>} [health]
 */

/**
 * One signing identity. `sendUnavailable` is how a pool reports a key it holds
 * but cannot sign with, so the engine can skip it instead of failing a launch.
 *
 * @typedef {object} WalletHandle
 * @property {string} address
 * @property {string} label
 * @property {() => Promise<bigint>} balance
 * @property {object} signer          Chain-native signer (viem account, Solana Keypair).
 */

/**
 * @typedef {object} WalletPool
 * @property {string} chain
 * @property {() => WalletHandle[]} list
 * @property {(opts?: {minBalance?: bigint, exclude?: string[]}) => Promise<WalletHandle|null>} pick
 * @property {(address: string, at?: number) => void} markUsed
 */

/**
 * Durable state. Dedupe is the load-bearing method: it is what stops the relay
 * from launching the same source coin twice across restarts.
 *
 * @typedef {object} Store
 * @property {(key: string) => Promise<boolean>} seen
 * @property {(key: string) => Promise<void>} mark
 * @property {(record: object) => Promise<void>} record
 * @property {(opts?: {since?: number}) => Promise<object[]>} history
 */

/**
 * @typedef {object} Logger
 * @property {(...args: any[]) => void} info
 * @property {(...args: any[]) => void} warn
 * @property {(...args: any[]) => void} error
 * @property {(...args: any[]) => void} debug
 */

export {};
