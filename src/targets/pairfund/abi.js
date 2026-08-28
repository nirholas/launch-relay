// PAIR V5 launchpad ABI, trimmed to what a launcher calls.
//
// The proxy address is the V5 launchpad on Robinhood Chain. It is pinned here
// as a default and overridable in config, because pinning an address in a bot
// that spends money is the difference between a paused upgrade and a transfer
// to whatever contract answers today.

export const PAIR_LAUNCHPAD_V5 = '0x8660A7F019C7943b0b0A91B8E39AFf3b6DB6Ae62';

/** Fixed supply every PAIR token mints, split across its pools by weight. */
export const PAIR_TOTAL_SUPPLY = 1_000_000_000n;

/** Pool weights are basis points and must total exactly this. */
export const BPS_TOTAL = 10_000;

/** PAIR accepts between one and five paired stock markets per launch. */
export const MIN_MARKETS = 1;
export const MAX_MARKETS = 5;

export const launchpadAbi = [
	{
		name: 'launchFeeWei',
		type: 'function',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ type: 'uint256' }],
	},
	{
		name: 'launchTokenMulti',
		type: 'function',
		stateMutability: 'payable',
		inputs: [
			{
				name: 'p',
				type: 'tuple',
				components: [
					{ name: 'name', type: 'string' },
					{ name: 'symbol', type: 'string' },
					{ name: 'metadataURI', type: 'string' },
					{ name: 'metadataHash', type: 'bytes32' },
					{
						name: 'allocations',
						type: 'tuple[]',
						components: [
							{ name: 'quoteToken', type: 'address' },
							{ name: 'weightBps', type: 'uint16' },
						],
					},
					{ name: 'creatorFeeRecipient', type: 'address' },
					{ name: 'developerBuyRecipient', type: 'address' },
					{ name: 'developerBuyPairIndex', type: 'uint8' },
					{ name: 'developerTokenAmountOut', type: 'uint256' },
					{ name: 'maxQuoteAmountIn', type: 'uint256' },
					{ name: 'deadline', type: 'uint256' },
				],
			},
		],
		outputs: [{ name: 'projectToken', type: 'address' }],
	},
];

/**
 * PairV4Locker. Swap fees do not land in a creator's wallet: they accumulate
 * inside the locked V4 position, PAIR's keeper sweeps them roughly hourly, and
 * they wait here until claimed.
 */
export const PAIR_V4_LOCKER = '0xeFcF476E8870fB3eb8680f039414fdcCE6C2a117';

export const lockerAbi = [
	{
		name: 'claim',
		type: 'function',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'asset', type: 'address' }],
		outputs: [{ name: 'amount', type: 'uint256' }],
	},
	{
		name: 'claimable',
		type: 'function',
		stateMutability: 'view',
		inputs: [{ name: 'wallet', type: 'address' }, { name: 'asset', type: 'address' }],
		outputs: [{ type: 'uint256' }],
	},
];

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The uint8 sentinel that means "no developer buy".
 *
 * This is not documented anywhere and it is not zero. Zero is a valid market
 * index, so a launch that passes index 0 with a zero amount is asking to buy
 * nothing out of the first pool, and the contract rejects it with
 * `InvalidDeveloperBuy()` (0xc81a59ab). Confirmed by decoding the calldata of
 * real no-buy launches on chain, which all pass 255 here along with the
 * creator's own address as the recipient.
 */
export const NO_DEVELOPER_BUY = 255;
