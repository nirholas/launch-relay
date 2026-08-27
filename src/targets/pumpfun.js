// pump.fun launchpad target (Solana).
//
// The second target exists to prove the first one is not the architecture. A
// launchpad on a different chain, with a different fee model, a different
// metadata host, and a transaction the venue builds for us rather than one we
// encode, still fits behind `plan` and `execute` without the engine knowing.
//
// pump.fun builds the create transaction server-side and partial-signs it with
// the mint keypair it generated; the launching wallet co-signs and submits. So
// planning here means: pin metadata, ask for the transaction, and simulate it
// to learn the real cost. Cost is measured, not estimated: simulation reports
// the payer's post-transaction lamports, and the difference from its current
// balance is what the launch actually spends.

import { fetchImageBytes, fetchJson } from '../http.js';

export const PUMP_AGENTS_API = 'https://fun-block.pump.fun/agents/create-coin';
export const PUMP_IPFS_ENDPOINT = 'https://pump.fun/api/ipfs';
export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const IPFS_TIMEOUT_MS = 30_000;

/**
 * @param {object} [opts]
 * @param {string} [opts.rpcUrl]
 * @param {number} [opts.initialBuySol]   Creator's own first buy, in SOL. Default 0.
 * @param {number} [opts.priorityFeeSol]  Extra priority fee. Default 0.
 * @param {string} [opts.apiUrl]
 * @returns {import('../types.js').Target}
 */
export function createPumpFunTarget(opts = {}) {
	const rpcUrl = opts.rpcUrl || DEFAULT_SOLANA_RPC;
	const apiUrl = opts.apiUrl || PUMP_AGENTS_API;
	const initialBuyLamports = solToLamports(opts.initialBuySol ?? 0);
	const priorityFeeLamports = solToLamports(opts.priorityFeeSol ?? 0);

	let web3 = null;
	const loadWeb3 = async () => {
		if (!web3) web3 = await import('@solana/web3.js');
		return web3;
	};

	return {
		id: 'pumpfun',
		chain: 'solana',
		chainId: 0,
		nativeSymbol: 'SOL',
		nativeDecimals: 9,
		rpcUrl,

		async health() {
			const { blockhash } = await rpcCall(rpcUrl, 'getLatestBlockhash', [{ commitment: 'finalized' }]);
			return { ok: Boolean(blockhash), detail: blockhash ? `rpc reachable, blockhash ${blockhash.slice(0, 8)}` : 'rpc returned no blockhash' };
		},

		/**
		 * @param {import('../types.js').LaunchSpec} spec
		 * @param {{wallet: import('../types.js').WalletHandle, log: import('../types.js').Logger, dryRun?: boolean}} ctx
		 */
		async plan(spec, { wallet, log, dryRun = false }) {
			const { Connection, VersionedTransaction, PublicKey } = await loadWeb3();
			const connection = wallet.connection || new Connection(rpcUrl, 'confirmed');
			const warnings = [];

			let metadataUri;
			if (dryRun) {
				metadataUri = 'https://ipfs.io/ipfs/dry-run-not-pinned';
				warnings.push('dry run: metadata was not pinned to IPFS');
			} else {
				metadataUri = await pinMetadata(spec, log);
				if (!metadataUri) throw new Error('pump.fun metadata pinning returned no URI');
			}

			const built = await fetchJson(apiUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					user: wallet.address,
					name: spec.name,
					symbol: spec.symbol,
					uri: metadataUri,
					solLamports: initialBuyLamports.toString(),
					encoding: 'base64',
					feePayer: wallet.address,
					creator: wallet.address,
				}),
				timeoutMs: 30_000,
			});
			if (!built?.transaction) throw new Error('pump.fun create-coin returned no transaction');

			const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, 'base64'));

			// Measure the real cost by simulating against the payer's account and
			// reading its post-transaction lamports. Rent for the accounts the
			// launch creates is invisible to a fee estimate but very much leaves
			// the wallet.
			let costLamports = initialBuyLamports + priorityFeeLamports;
			try {
				const before = await connection.getBalance(new PublicKey(wallet.address));
				const sim = await connection.simulateTransaction(tx, {
					sigVerify: false,
					replaceRecentBlockhash: true,
					accounts: { encoding: 'base64', addresses: [wallet.address] },
				});
				if (sim.value.err) throw new Error(`simulation error ${JSON.stringify(sim.value.err)}`);
				const after = sim.value.accounts?.[0]?.lamports;
				if (typeof after === 'number' && after <= before) costLamports = BigInt(before - after);
			} catch (err) {
				const detail = err?.message || String(err);
				if (dryRun) warnings.push(`simulation failed: ${detail}`);
				else throw new Error(`pump.fun launch simulation failed: ${detail}`);
			}

			return {
				target: 'pumpfun',
				chain: 'solana',
				chainId: 0,
				spec,
				wallet: wallet.address,
				contract: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
				cost: {
					nativeSymbol: 'SOL',
					feeNative: lamportsToSol(costLamports - initialBuyLamports),
					gasNative: '0',
					totalNative: lamportsToSol(costLamports),
					totalBase: costLamports,
				},
				warnings,
				dryRun,
				call: { transaction: built.transaction, mint: built.mintPublicKey || null },
				metadata: { metadataURI: metadataUri },
				summary: [
					`launchpad   pump.fun (Pump program) on Solana`,
					`token       ${spec.name} (${spec.symbol}), mint ${built.mintPublicKey || 'assigned at build time'}`,
					`from wallet ${wallet.address} (${wallet.label})`,
					`initial buy ${lamportsToSol(initialBuyLamports)} SOL`,
					`total cost  ${lamportsToSol(costLamports)} SOL`,
					`metadata    ${metadataUri}`,
					`origin      ${spec.origin.source} ${spec.origin.address || ''}`.trim(),
				],
			};
		},

		/**
		 * @param {import('../types.js').LaunchPlan} plan
		 * @param {{wallet: import('../types.js').WalletHandle, log: import('../types.js').Logger}} ctx
		 */
		async execute(plan, { wallet, log }) {
			if (plan.dryRun) throw new Error('cannot execute a dry-run plan; build a live plan first');
			const { Connection, VersionedTransaction } = await loadWeb3();
			const connection = wallet.connection || new Connection(rpcUrl, 'confirmed');

			const tx = VersionedTransaction.deserialize(Buffer.from(plan.call.transaction, 'base64'));

			// The blockhash inside this transaction is the one pump.fun's mint
			// keypair signed over, so it cannot be refreshed: replacing it would
			// invalidate that signature and the launch would be rejected for a
			// missing signer. A plan that sat through a long confirmation simply
			// expires, and an expired blockhash is a re-plan, not a retry.
			if (!(await blockhashStillValid(connection, tx))) {
				return { ok: false, error: 'the launch transaction expired before it was approved; re-plan to get a fresh one' };
			}

			tx.sign([wallet.signer]);
			const signature = await connection.sendRawTransaction(tx.serialize(), {
				skipPreflight: false,
				maxRetries: 3,
			});
			log.info(`launch tx sent ${signature}`);

			const status = await awaitSignature(connection, signature);
			if (status.err) {
				return {
					ok: false,
					txHash: signature,
					url: `https://solscan.io/tx/${signature}`,
					error: `transaction failed: ${JSON.stringify(status.err)}`,
				};
			}

			const mint = plan.call.mint;
			return {
				ok: true,
				txHash: signature,
				tokenAddress: mint,
				url: mint ? `https://pump.fun/coin/${mint}` : `https://solscan.io/tx/${signature}`,
				explorerUrl: `https://solscan.io/tx/${signature}`,
			};
		},
	};
}

/**
 * Pin the image and descriptor to pump.fun's own IPFS endpoint, which is what
 * the pump.fun UI reads. A coin whose metadata lives anywhere else renders
 * without a name or picture on the venue it launched on.
 */
async function pinMetadata(spec, log) {
	const form = new FormData();
	if (spec.imageUrl) {
		const image = await fetchImageBytes(spec.imageUrl, { timeoutMs: IPFS_TIMEOUT_MS });
		if (image) {
			const ext = image.contentType === 'image/jpeg' ? 'jpg' : image.contentType.split('/')[1] || 'png';
			form.append('file', new Blob([image.data], { type: image.contentType }), `image.${ext}`);
		} else {
			log.warn(`source image could not be fetched: ${spec.imageUrl}`);
		}
	}
	form.append('name', spec.name);
	form.append('symbol', spec.symbol);
	form.append('description', spec.description || '');
	form.append('twitter', spec.links?.twitter || '');
	form.append('telegram', spec.links?.telegram || '');
	form.append('website', spec.links?.website || '');
	form.append('showName', 'true');

	const res = await fetch(PUMP_IPFS_ENDPOINT, { method: 'POST', body: form, signal: AbortSignal.timeout(IPFS_TIMEOUT_MS) });
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`pump.fun IPFS upload returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
	}
	const out = await res.json();
	return out?.metadataUri || out?.metadata_uri || out?.uri || null;
}

/**
 * Is the transaction's own blockhash still accepted by the cluster? Checked
 * before signing so an expired plan costs nothing instead of a failed send.
 */
async function blockhashStillValid(connection, tx) {
	try {
		const res = await connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' });
		return res?.value !== false;
	} catch {
		// An RPC that cannot answer is not proof of expiry; let the send decide.
		return true;
	}
}

/**
 * Poll for a signature's status instead of using the blockhash-bound confirm
 * helper, which needs a lastValidBlockHeight this transaction does not carry.
 */
async function awaitSignature(connection, signature, { timeoutMs = 90_000, intervalMs = 2_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { value } = await connection.getSignatureStatuses([signature]);
		const status = value?.[0];
		if (status?.err) return { err: status.err };
		if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { err: null };
		if (Date.now() >= deadline) return { err: 'confirmation timed out' };
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

async function rpcCall(url, method, params) {
	const body = await fetchJson(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (body?.error) throw new Error(`${method} failed: ${body.error.message || JSON.stringify(body.error)}`);
	return body?.result?.value ?? body?.result;
}

function solToLamports(sol) {
	const n = Number(sol || 0);
	if (!Number.isFinite(n) || n < 0) throw new Error(`invalid SOL amount: ${sol}`);
	return BigInt(Math.round(n * Number(LAMPORTS_PER_SOL)));
}

function lamportsToSol(lamports) {
	const value = lamports < 0n ? 0n : lamports;
	const whole = value / LAMPORTS_PER_SOL;
	const frac = (value % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
	return frac ? `${whole}.${frac}` : `${whole}`;
}
