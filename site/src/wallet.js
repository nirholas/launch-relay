// Talking to whatever wallet the browser has.
//
// EIP-1193 and nothing else: no connector library, no project id, no third
// party between the page and the extension. The page needs four things from a
// wallet (who you are, which chain, sign this, wait for it) and all four are
// one request each.

import { createWalletClient, custom } from 'viem';
import { CHAIN_ID, RPC_URL, chain } from './shared.js';

export class NoWalletError extends Error {
	constructor() {
		super('No wallet found in this browser. Install a wallet extension, or use the command line: npx launch-relay launch');
		this.name = 'NoWalletError';
	}
}

export function provider() {
	return typeof window !== 'undefined' ? window.ethereum : undefined;
}

export const hasWallet = () => Boolean(provider());

/**
 * Ask for an account and make sure the wallet is pointed at Robinhood Chain.
 *
 * Adding the chain is offered rather than assumed: a wallet that already knows
 * it keeps whatever RPC its owner configured, which may well be better than
 * the public one.
 */
export async function connect() {
	const eth = provider();
	if (!eth) throw new NoWalletError();

	const accounts = await eth.request({ method: 'eth_requestAccounts' });
	const address = accounts?.[0];
	if (!address) throw new Error('the wallet returned no account');

	const current = await eth.request({ method: 'eth_chainId' });
	if (Number.parseInt(current, 16) !== CHAIN_ID) await switchChain();

	return { address, client: walletClient(address) };
}

export function walletClient(account) {
	return createWalletClient({ account, chain, transport: custom(provider()) });
}

async function switchChain() {
	const eth = provider();
	const hexId = `0x${CHAIN_ID.toString(16)}`;
	try {
		await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
	} catch (err) {
		// 4902 is "the wallet has never heard of this chain".
		if (err?.code !== 4902 && err?.data?.originalError?.code !== 4902) throw err;
		await eth.request({
			method: 'wallet_addEthereumChain',
			params: [{
				chainId: hexId,
				chainName: 'Robinhood Chain',
				nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
				rpcUrls: [RPC_URL],
				blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
			}],
		});
	}
}

/** Re-read the connected account without prompting. */
export async function currentAccount() {
	const eth = provider();
	if (!eth) return null;
	const accounts = await eth.request({ method: 'eth_accounts' }).catch(() => []);
	return accounts?.[0] ?? null;
}

/**
 * Subscribe to the two events that invalidate everything on screen.
 * Returns an unsubscribe function.
 */
export function onWalletChange(handler) {
	const eth = provider();
	if (!eth?.on) return () => {};
	const onAccounts = (accounts) => handler({ address: accounts?.[0] ?? null });
	const onChain = (chainId) => handler({ chainId: Number.parseInt(chainId, 16) });
	eth.on('accountsChanged', onAccounts);
	eth.on('chainChanged', onChain);
	return () => {
		eth.removeListener?.('accountsChanged', onAccounts);
		eth.removeListener?.('chainChanged', onChain);
	};
}

/** A wallet handle in the shape the library's targets expect. */
export function walletHandle({ address, client, publicClient }) {
	return {
		address,
		label: 'wallet',
		signer: address,
		client,
		publicClient,
		balance: () => publicClient.getBalance({ address }),
	};
}
