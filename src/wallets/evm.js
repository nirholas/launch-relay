// EVM wallet pool.
//
// Three ways to hold "different wallets", because the right one depends on how
// the operator wants to manage keys:
//
//   mnemonic  one BIP-39 seed, N derived accounts. Best default: one secret to
//             back up, and the addresses are recoverable in any wallet app.
//   keys      explicit private keys. For wallets that already exist and are
//             already funded.
//   file      a JSON array of either, kept out of the process environment.
//
// A pool never signs. It hands back a WalletHandle carrying a viem account and
// a wallet client; the target builds and sends the transaction. That keeps the
// blast radius of a target adapter to one wallet at a time.

import { createPublicClient, createWalletClient, http } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { readFile } from 'node:fs/promises';
import { pickWallet } from './rotation.js';

/**
 * @param {object} opts
 * @param {import('viem').Chain} opts.chain
 * @param {string} [opts.rpcUrl]                Defaults to the chain's own RPC.
 * @param {string} [opts.mnemonic]
 * @param {number} [opts.count]                 Accounts to derive from the mnemonic. Default 3.
 * @param {number} [opts.startIndex]            First derivation index. Default 0.
 * @param {string[]} [opts.privateKeys]
 * @param {string} [opts.keyFile]               JSON: {mnemonic, count} or an array of private keys.
 * @param {string} [opts.strategy]              See wallets/rotation.js. Default 'round-robin'.
 * @returns {Promise<import('../types.js').WalletPool>}
 */
export async function createEvmWalletPool(opts) {
	const {
		chain, rpcUrl, mnemonic, count = 3, startIndex = 0,
		privateKeys = [], keyFile, strategy = 'round-robin',
	} = opts;
	if (!chain) throw new Error('createEvmWalletPool needs a viem chain');

	const transport = http(rpcUrl || chain.rpcUrls?.default?.http?.[0]);
	const publicClient = createPublicClient({ chain, transport });

	const accounts = await loadAccounts({ mnemonic, count, startIndex, privateKeys, keyFile });
	if (!accounts.length) {
		throw new Error(
			'no EVM wallets configured: pass mnemonic, privateKeys, or keyFile (see README "Wallets")',
		);
	}

	/** @type {import('../types.js').WalletHandle[]} */
	const handles = accounts.map(({ account, label }) => ({
		address: account.address,
		label,
		signer: account,
		client: createWalletClient({ account, chain, transport }),
		publicClient,
		balance: () => publicClient.getBalance({ address: account.address }),
	}));

	const usage = new Map();
	let cursor = 0;

	return {
		chain: chain.name,
		chainId: chain.id,
		publicClient,
		list: () => handles.slice(),

		/**
		 * Pick a wallet that can actually pay. Balances are read live for every
		 * candidate: a pool whose first wallet is empty must fall through to the
		 * next one rather than failing the launch.
		 */
		async pick({ minBalance = 0n, exclude = [] } = {}) {
			const excluded = new Set(exclude.map((a) => String(a).toLowerCase()));
			const balances = new Map();
			const candidates = [];
			for (const h of handles) {
				if (excluded.has(h.address.toLowerCase())) continue;
				let bal;
				try {
					bal = await h.balance();
				} catch {
					// An RPC that cannot answer for one address is not evidence the
					// wallet is empty, but it is evidence we cannot safely spend from
					// it right now. Skip and let another wallet take the launch.
					continue;
				}
				balances.set(h.address.toLowerCase(), bal);
				if (bal >= minBalance) candidates.push(h);
			}
			const picked = pickWallet(candidates, { strategy, usage, balances, cursor });
			cursor = picked.cursor;
			return picked.wallet;
		},

		markUsed(address, at = Date.now()) {
			const key = String(address).toLowerCase();
			const prev = usage.get(key) || { lastUsedAt: 0, launches: 0 };
			usage.set(key, { lastUsedAt: at, launches: prev.launches + 1 });
		},

		usage,
	};
}

async function loadAccounts({ mnemonic, count, startIndex, privateKeys, keyFile }) {
	const out = [];
	const seen = new Set();
	const push = (account, label) => {
		const key = account.address.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ account, label });
	};

	let fileConfig = null;
	if (keyFile) {
		const parsed = JSON.parse(await readFile(keyFile, 'utf8'));
		fileConfig = Array.isArray(parsed) ? { privateKeys: parsed } : parsed;
	}

	const seed = mnemonic || fileConfig?.mnemonic;
	if (seed) {
		const n = fileConfig?.count ?? count;
		const first = fileConfig?.startIndex ?? startIndex;
		for (let i = first; i < first + n; i++) {
			push(mnemonicToAccount(seed, { addressIndex: i }), `hd-${i}`);
		}
	}

	const keys = [...privateKeys, ...(fileConfig?.privateKeys || [])];
	keys.forEach((raw, i) => {
		const hex = normalizeKey(raw);
		if (!hex) return;
		push(privateKeyToAccount(hex), `key-${i}`);
	});

	return out;
}

function normalizeKey(raw) {
	const trimmed = String(raw || '').trim();
	if (!trimmed) return null;
	const hex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
	if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(`private key "${short(trimmed)}" is not 32 hex bytes`);
	}
	return hex;
}

const short = (s) => (s.length > 10 ? `${s.slice(0, 6)}...` : s);
