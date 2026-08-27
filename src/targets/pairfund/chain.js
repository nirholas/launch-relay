// Robinhood Chain, the EVM network PAIR runs on.
//
// Defined here rather than imported from viem/chains so the adapter works on
// any viem version and so the RPC stays overridable: a public RPC is a single
// point of failure for a bot that must land a transaction, and swapping in a
// private endpoint should be one config field, not a fork.

import { defineChain } from 'viem';

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD_EXPLORER = 'https://robinhoodchain.blockscout.com';

/**
 * @param {{rpcUrl?: string}} [opts]
 * @returns {import('viem').Chain}
 */
export function robinhoodChain({ rpcUrl } = {}) {
	const http = [rpcUrl || ROBINHOOD_RPC_URL];
	return defineChain({
		id: ROBINHOOD_CHAIN_ID,
		name: 'Robinhood Chain',
		nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: { default: { http } },
		blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_EXPLORER } },
	});
}

export const txUrl = (hash) => `${ROBINHOOD_EXPLORER}/tx/${hash}`;
export const addressUrl = (address) => `${ROBINHOOD_EXPLORER}/address/${address}`;
