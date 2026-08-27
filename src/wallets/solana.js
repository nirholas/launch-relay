// Solana wallet pool.
//
// Same contract as the EVM pool: hold keys, report balances, hand out one
// handle at a time, never sign. @solana/web3.js and bs58 are optional
// dependencies loaded on first use, so an EVM-only deployment does not carry a
// Solana runtime it never calls.

import { readFile } from 'node:fs/promises';
import { pickWallet } from './rotation.js';

export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

let _web3 = null;
let _bs58 = null;

async function solanaDeps() {
	if (!_web3) {
		try {
			_web3 = await import('@solana/web3.js');
			_bs58 = (await import('bs58')).default;
		} catch (err) {
			throw new Error(
				`Solana support needs @solana/web3.js and bs58: npm install @solana/web3.js bs58 (${err.message})`,
			);
		}
	}
	return { web3: _web3, bs58: _bs58 };
}

/**
 * @param {object} opts
 * @param {string} [opts.rpcUrl]
 * @param {string[]} [opts.secretKeys]  Base58 secret keys, or JSON byte arrays as strings.
 * @param {string} [opts.keyFile]       JSON array of either form.
 * @param {string} [opts.strategy]
 * @returns {Promise<import('../types.js').WalletPool>}
 */
export async function createSolanaWalletPool(opts = {}) {
	const { web3, bs58 } = await solanaDeps();
	const { rpcUrl = DEFAULT_SOLANA_RPC, secretKeys = [], keyFile, strategy = 'round-robin' } = opts;
	const connection = new web3.Connection(rpcUrl, 'confirmed');

	const raw = [...secretKeys];
	if (keyFile) {
		const parsed = JSON.parse(await readFile(keyFile, 'utf8'));
		raw.push(...(Array.isArray(parsed) ? parsed : parsed.secretKeys || []));
	}

	const seen = new Set();
	/** @type {import('../types.js').WalletHandle[]} */
	const handles = [];
	raw.forEach((entry, i) => {
		const keypair = toKeypair(entry, web3, bs58);
		const address = keypair.publicKey.toBase58();
		if (seen.has(address)) return;
		seen.add(address);
		handles.push({
			address,
			label: `sol-${i}`,
			signer: keypair,
			connection,
			balance: async () => BigInt(await connection.getBalance(keypair.publicKey)),
		});
	});

	if (!handles.length) {
		throw new Error('no Solana wallets configured: set LAUNCH_RELAY_SOLANA_KEYS or pass secretKeys/keyFile');
	}

	const usage = new Map();
	let cursor = 0;

	return {
		chain: 'solana',
		connection,
		list: () => handles.slice(),

		async pick({ minBalance = 0n, exclude = [] } = {}) {
			const excluded = new Set(exclude.map((a) => String(a)));
			const balances = new Map();
			const candidates = [];
			for (const h of handles) {
				if (excluded.has(h.address)) continue;
				let bal;
				try {
					bal = await h.balance();
				} catch {
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

/**
 * Accept the three shapes a Solana secret key arrives in: a base58 string, a
 * JSON array of 64 bytes, and an already-parsed array. Getting this wrong
 * produces a valid-looking keypair for the wrong address, so the length is
 * checked rather than assumed.
 */
function toKeypair(entry, web3, bs58) {
	if (Array.isArray(entry)) return web3.Keypair.fromSecretKey(Uint8Array.from(entry));
	const text = String(entry).trim();
	if (text.startsWith('[')) {
		const bytes = JSON.parse(text);
		if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error('Solana secret key array must hold 64 bytes');
		return web3.Keypair.fromSecretKey(Uint8Array.from(bytes));
	}
	const decoded = bs58.decode(text);
	if (decoded.length !== 64) throw new Error(`Solana secret key decoded to ${decoded.length} bytes, expected 64`);
	return web3.Keypair.fromSecretKey(decoded);
}
