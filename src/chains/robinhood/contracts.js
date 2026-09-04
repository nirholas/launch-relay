// The Robinhood Chain address book.
//
// Every address below was read off the chain, not off a docs page. The
// comment on each entry says how, so a reader can reproduce the check instead
// of trusting this file:
//
//   npm run rhc:verify        (tools/verify-addresses.mjs)
//
// That script re-derives every one of them from live state and exits non-zero
// on a mismatch, which is what makes an address book in a bot that spends
// money safe to keep in a repository at all.

/** Canonical assets. Anything a launch can be quoted against starts here. */
export const TOKENS = Object.freeze({
	/** Wrapped ETH. Read as token0 of the Uniswap V3 USDG/WETH pool, and as WETH9() on the V3 position manager. */
	WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
	/** Global Dollar, the chain's dominant stable quote. 6 decimals, not 18. Read as token1 of that same pool. */
	USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
	/** Virtuals Protocol. The quote asset every agent token launched through the Virtuals bonding curve trades against. */
	VIRTUAL: '0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31',
});

export const DECIMALS = Object.freeze({
	[TOKENS.WETH.toLowerCase()]: 18,
	[TOKENS.USDG.toLowerCase()]: 6,
	[TOKENS.VIRTUAL.toLowerCase()]: 18,
});

/** Chain-agnostic infrastructure that happens to be deployed here at its canonical address. */
export const INFRA = Object.freeze({
	/** Uniswap Permit2. Verified by reading non-empty bytecode at the canonical address. */
	PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
	/** Multicall3, at its usual deterministic address. */
	MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
	/** ERC-4337 EntryPoint v0.7. Several launches on this chain arrive as user operations through it. */
	ENTRY_POINT_V07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
});

/**
 * Automated market makers, grouped by the interface family a pool-creating
 * launch has to speak. Forks are listed beside the canonical deployment
 * because they take the same calls: a launch that works against Uniswap V3
 * works against any V3 fork by swapping the factory address.
 */
export const AMMS = Object.freeze({
	'uniswap-v2': Object.freeze({
		family: 'v2',
		label: 'Uniswap V2',
		/** allPairsLength() answered with a five-figure pair count, so this is the live factory. */
		factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
		/** Router02. factory() and WETH() on it both match the entries above. */
		router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',
		/** Constant product, one fee, no tick math. */
		feeBps: 30,
	}),
	'uniswap-v3': Object.freeze({
		family: 'v3',
		label: 'Uniswap V3',
		/** Emitter of the overwhelming majority of PoolCreated logs on this chain. */
		factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
		/** NonfungiblePositionManager. name() returns "Uniswap V3 Positions NFT-V1" and factory() matches. */
		positionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
		/** fee -> tickSpacing, read back one tier at a time from feeAmountTickSpacing(). */
		feeTiers: Object.freeze({ 100: 1, 500: 10, 3000: 60, 10000: 200 }),
	}),
	'uniswap-v4': Object.freeze({
		family: 'v4',
		label: 'Uniswap V4',
		/** Sole emitter of V4 Initialize logs on this chain. */
		poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
		/** PositionManager. name() returns "Uniswap v4 Positions NFT"; poolManager() and permit2() both match. */
		positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
		permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
		/** V4 decouples fee from spacing, so a launch picks both. These are the pairings in live use. */
		feeTiers: Object.freeze({ 100: 1, 500: 10, 3000: 60, 10000: 200 }),
	}),
});

/**
 * V2 and V3 forks seen creating pools on this chain. They are addressable by
 * the same adapters, so they are exposed as alternative factories rather than
 * as separate integrations. Counts are pool-creation events observed in the
 * sampling window that found them, not a ranking.
 */
export const AMM_FORKS = Object.freeze({
	v2: Object.freeze([
		'0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
		'0x0d1eBb179cdbcA88D74C923C4255Cb2B17474AfD',
		'0xFC2E4Da3EdB2E18100473339c763705d263D20A9',
		'0x919C4D6C58b4C885707a2b9dEd879742A13b0baa',
		'0xc802A440559cEE8A66E2023403d34Be9084A720e',
	]),
	v3: Object.freeze([
		'0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
		'0xEce6eCd61177336ea6Fb9b17937AC439D85EE20B',
		'0xE51960f1B45f1C9FB6D166E6a884F866fC70433B',
		'0x5C0f590Dbbcf1e8184eB121e6ED7cB924bbc4Cf6',
		'0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8',
		'0xcA8152ab363dC2F23BB30f6c6c2678028E7cF30a',
		'0xD3504c3A32467e5e3c988AaF500Dd689285c587E',
	]),
});

/** Uniswap V4 addresses zero for native ETH rather than wrapping it. */
export const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';
