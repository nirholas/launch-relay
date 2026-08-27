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

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
