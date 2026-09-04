// Robinhood Chain: the network definition every venue in this directory shares.
//
// Defined here rather than imported from viem/chains so the toolkit works on
// any viem version, and so the RPC stays overridable: a public endpoint is a
// single point of failure for a bot that must land a transaction, and swapping
// in a private one should be one config field, not a fork.

import { defineChain } from 'viem';

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD_EXPLORER = 'https://robinhoodchain.blockscout.com';

/** Native currency. Robinhood Chain settles gas in ETH, like the L2s it sits beside. */
export const NATIVE = Object.freeze({ symbol: 'ETH', name: 'Ether', decimals: 18 });

/**
 * @param {{rpcUrl?: string}} [opts]
 * @returns {import('viem').Chain}
 */
export function robinhoodChain({ rpcUrl } = {}) {
	const http = [rpcUrl || ROBINHOOD_RPC_URL];
	return defineChain({
		id: ROBINHOOD_CHAIN_ID,
		name: 'Robinhood Chain',
		nativeCurrency: { name: NATIVE.name, symbol: NATIVE.symbol, decimals: NATIVE.decimals },
		rpcUrls: { default: { http } },
		blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_EXPLORER } },
	});
}

export const txUrl = (hash) => `${ROBINHOOD_EXPLORER}/tx/${hash}`;
export const addressUrl = (address) => `${ROBINHOOD_EXPLORER}/address/${address}`;
export const tokenUrl = (address) => `${ROBINHOOD_EXPLORER}/token/${address}`;
