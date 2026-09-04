// Learn Robinhood Chain's launch venues from the chain itself.
//
// The catalog in venues/catalog.json was not typed out. It was produced by
// this module, and re-running it is how the catalog stays true as venues ship
// new contracts:
//
//   npm run rhc:discover
//
// The method is deliberately dumb, which is why it works on a chain where most
// launchpads publish nothing. Every ERC-20 that has ever existed emitted a
// Transfer from the zero address when its supply was minted. Find those logs,
// take the transaction that produced each one, and the contract it called is
// by definition the thing that launched the token. Group by (contract,
// selector) and the venues sort themselves, ranked by how many tokens they
// actually launched rather than by how loudly they market.
//
// From there each group needs a human-readable ABI. Selectors resolve through
// the Openchain signature database, which indexes verified contracts across
// chains, so a launchpad that deployed the same code elsewhere is legible here
// even when its Robinhood Chain deployment is unverified. A selector nothing
// can name is still reported, with its launch count, so the gap is visible
// instead of silently dropped.

import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiItem, stringToBytes } from 'viem';
import { argumentTypes, dehydrate, encodeLaunchCall, readPath, splitType, tupleComponents, verifyDescriptor } from './venues/descriptor.js';
import { CONFIRMED_ENTRY_POINTS, applyOverride } from './venues/overrides.js';
import { fundOverride, isErc20 } from './erc20-slots.js';
import { inlineMetadataHost, toBase64 } from './metadata.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const OPENCHAIN_LOOKUP = 'https://api.openchain.xyz/signature-database/v1/lookup';

/**
 * An AMM pool is an ERC-20 too, and it mints its supply from the zero address
 * exactly like a launch does. Pools answer `token0()`; launch tokens do not.
 */
const poolAbi = parseAbi(['function token0() view returns (address)']);

const erc20Abi = parseAbi([
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
]);

/**
 * Whether a function name reads as the entry point of a launch.
 *
 * A token can be minted from the zero address by plenty of things that are not
 * launches: an L2 bridge crediting a deposit, an aggregator routing through
 * somebody else's launchpad, a smart account forwarding a user operation. All
 * of them look identical to the scan, because all of them produce the same
 * log, and driving one of them as if it were a launchpad would at best revert
 * and at worst move funds through a router on terms nobody chose.
 *
 * Nothing on chain distinguishes them structurally without archive state this
 * chain's public RPC does not serve, so the test is the function's own name.
 * It is a weak signal used conservatively: a name that does not read as a
 * launch does not disqualify the venue from the catalog, it only stops the
 * toolkit from driving it unattended. `venues/overrides.js` can confirm one.
 *
 * @param {string} signature
 * @returns {{launch: boolean, reason?: string}}
 */
export function classifyLaunchFunction(signature) {
	const name = signature.slice(0, signature.indexOf('(')) || signature;
	// Forwarding and settlement verbs, checked first: `createAndSwap` is a
	// launch, `swapAndCreate` on a router is not, and the deny list is about
	// what the contract is rather than what the call happens to include.
	if (/^(multicall|aggregate|execute|swap|deposit|withdraw|finalize|handleOps|permit|approve|transfer|bridge|relay|forward|proxy|fallback)/i.test(name)) {
		return { launch: false, reason: `the function that minted this token, ${name}(), reads as a router, bridge, or forwarder rather than a launch entry point` };
	}
	if (/(launch|create|deploy|coin|token|graduat|coinbase|bond)/i.test(name)) return { launch: true };
	if (/^new[A-Z]/.test(name)) return { launch: true };
	return { launch: false, reason: `the function that minted this token, ${name}(), does not read as a launch entry point` };
}

/**
 * Contracts that show up as the transaction target but are not launchpads:
 * they forward a call to one. A launch routed through them is counted against
 * the venue only once the inner call is resolved, so they are excluded rather
 * than published as venues in their own right.
 */
export const CALL_FORWARDERS = Object.freeze({
	'0x0000000071727de22e5e9d8baf0edac6f37da032': 'ERC-4337 EntryPoint v0.7',
	'0xca11bde05977b3631167028862be2a173976ca11': 'Multicall3',
	'0xce0042b868300000d44a59004da54a005ffdcf9f': 'CREATE3 deployer',
});

/**
 * Scan a block range for token mints and attribute each to the contract that
 * produced it.
 *
 * Ranges are chunked because public RPCs cap a `eth_getLogs` response, and the
 * cap is expressed in matched logs rather than blocks, so a chunk that works
 * during a quiet hour fails during a busy one. A chunk that trips the cap is
 * split rather than skipped: dropping it would silently under-count exactly
 * the venues that are busiest.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {bigint} opts.fromBlock
 * @param {bigint} opts.toBlock
 * @param {bigint} [opts.chunk]
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<Array<{token: string, txHash: string, blockNumber: bigint}>>}
 */
export async function scanMints({ client, fromBlock, toBlock, chunk = 2_000n, onProgress }) {
	const found = new Map();
	const queue = [[fromBlock, toBlock]];
	while (queue.length) {
		const [start, end] = queue.shift();
		const span = end - start + 1n;
		if (span > chunk) {
			const mid = start + span / 2n;
			queue.unshift([start, mid - 1n], [mid, end]);
			continue;
		}
		let logs;
		try {
			logs = await client.request({
				method: 'eth_getLogs',
				params: [{ topics: [TRANSFER_TOPIC, ZERO_TOPIC], fromBlock: toHex(start), toBlock: toHex(end) }],
			});
		} catch (err) {
			if (isTooManyLogs(err) && span > 1n) {
				const mid = start + span / 2n;
				queue.unshift([start, mid - 1n], [mid, end]);
				continue;
			}
			throw err;
		}
		for (const log of logs) {
			// ERC-721 shares ERC-20's Transfer topic and differs only in shape:
			// it indexes the token id, so it carries four topics and no data.
			// Without this filter every Uniswap V3 position NFT ever minted
			// arrives as a token launch.
			if (log.topics.length !== 3 || !log.data || log.data === '0x') continue;
			// The first mint a token ever emits is the one that created its
			// supply. Later mints belong to a rebasing or wrapper contract and
			// say nothing about who launched it.
			const token = getAddress(log.address);
			const blockNumber = BigInt(log.blockNumber);
			const existing = found.get(token.toLowerCase());
			if (!existing || blockNumber < existing.blockNumber) {
				found.set(token.toLowerCase(), { token, txHash: log.transactionHash, blockNumber });
			}
		}
		onProgress?.(`scanned ${start}-${end}, ${found.size} token(s) so far`);
	}
	return [...found.values()].sort((a, b) => Number(a.blockNumber - b.blockNumber));
}

/** LP shares and pool tokens are not launches. */
export async function isPoolToken(client, address) {
	try {
		await client.readContract({ address, abi: poolAbi, functionName: 'token0' });
		return true;
	} catch {
		return false;
	}
}

const toHex = (value) => `0x${BigInt(value).toString(16)}`;
const isTooManyLogs = (err) => /exceeds? limit|too many|response size|query returned more/i.test(String(err?.details || err?.message || err));

/**
 * Group mints by the contract and function that produced them.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {Array<{token: string, txHash: string, blockNumber: bigint}>} opts.mints
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<Array<object>>} one group per (contract, selector)
 */
export async function groupByLauncher({ client, mints, onProgress }) {
	const groups = new Map();
	let seen = 0;
	for (const mint of mints) {
		seen++;
		if (await isPoolToken(client, mint.token)) continue;
		const tx = await client.getTransaction({ hash: mint.txHash }).catch(() => null);
		if (!tx?.to || !tx.input || tx.input.length < 10) continue;
		const address = getAddress(tx.to);
		const selector = tx.input.slice(0, 10);
		const key = `${address.toLowerCase()}:${selector}`;
		if (!groups.has(key)) groups.set(key, { address, selector, launches: [], forwarder: CALL_FORWARDERS[address.toLowerCase()] || null });
		groups.get(key).launches.push({ ...mint, from: getAddress(tx.from), value: tx.value, input: tx.input });
		if (seen % 25 === 0) onProgress?.(`resolved ${seen}/${mints.length} launch transactions`);
	}
	return [...groups.values()].sort((a, b) => b.launches.length - a.launches.length);
}

/**
 * Resolve 4-byte selectors to signatures.
 *
 * @param {string[]} selectors
 * @param {{fetchImpl?: typeof fetch, overrides?: Record<string, string>}} [opts]
 * @returns {Promise<Record<string, string|null>>}
 */
export async function lookupSignatures(selectors, { fetchImpl = fetch, overrides = {} } = {}) {
	const resolved = {};
	const pending = [];
	for (const selector of new Set(selectors)) {
		if (overrides[selector]) resolved[selector] = overrides[selector];
		else pending.push(selector);
	}
	for (let i = 0; i < pending.length; i += 40) {
		const batch = pending.slice(i, i + 40);
		const response = await fetchImpl(`${OPENCHAIN_LOOKUP}?function=${batch.join(',')}`);
		if (!response.ok) throw new Error(`signature lookup failed with ${response.status}`);
		const body = await response.json();
		for (const selector of batch) {
			const candidates = body?.result?.function?.[selector] || [];
			// Openchain returns every signature that hashes to the selector.
			// Collisions are rare but real, and the shortest name is not
			// necessarily right, so prefer one attached to a verified contract.
			const best = candidates.find((c) => c.hasVerifiedContract) || candidates[0];
			resolved[selector] = best?.name || null;
		}
	}
	return resolved;
}

/**
 * Walk a decoded argument tree with its ABI types, yielding every leaf.
 *
 * @param {any} node
 * @param {string} type
 * @param {number[]} [path]
 * @returns {Generator<{path: number[], type: string, value: any}>}
 */
export function* walkLeaves(node, type, path = []) {
	const { base, array } = splitType(type);
	if (array) {
		for (let i = 0; i < (node?.length ?? 0); i++) yield* walkLeaves(node[i], base, [...path, i]);
		return;
	}
	if (base.startsWith('(')) {
		const components = tupleComponents(base);
		for (let i = 0; i < components.length; i++) yield* walkLeaves(node?.[i], components[i], [...path, i]);
		return;
	}
	yield { path, type: base, value: node };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i;
const isUrl = (value) => typeof value === 'string' && /^(https?:|ipfs:|ar:|data:image)/i.test(value);

/**
 * Work out which leaves of an anchor transaction mean what.
 *
 * Matching is by value, not by position or by argument name: the token's real
 * name and symbol are read from the token contract, and any leaf equal to one
 * of them is that field. This is why the inference does not need the ABI to
 * have names, which is fortunate, because a signature recovered from a
 * selector never does.
 *
 * @param {object} opts
 * @param {any[]} opts.args      Decoded arguments of the anchor transaction.
 * @param {string[]} opts.types  Argument types, in order.
 * @param {{name?: string, symbol?: string, creator?: string, timestamp?: number}} opts.facts
 * @returns {Array<{role: string, path: number[], type: string}>}
 */
export function inferBindings({ args, types, facts }) {
	const bindings = [];
	const taken = new Set();
	const claim = (role, leaf) => {
		const key = leaf.path.join('.');
		// Every role is claimed once, except `salt`. A call can carry several
		// bytes32 arguments and only the live probe can say which of them a
		// launch may change, so all of them are proposed and the ones the venue
		// refuses are pruned there. Proposing only the first is how a real salt
		// ends up replayed: on one venue here the first bytes32 is a
		// configuration commitment and the second is the salt.
		if (taken.has(key) || (role !== 'salt' && bindings.some((b) => b.role === role))) return false;
		taken.add(key);
		bindings.push({ role, path: leaf.path, type: leaf.type });
		return true;
	};

	const leaves = [];
	for (let i = 0; i < types.length; i++) leaves.push(...walkLeaves(args[i], types[i], [i]));

	const strings = leaves.filter((l) => l.type === 'string' && typeof l.value === 'string');
	const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

	// Identity first: the exact name and symbol the token reports on chain.
	//
	// Stopping at the first *match* rather than the first successful *claim*
	// looks equivalent and is not. Memecoins routinely use the same string for
	// both, so the name claims that leaf, the symbol matches the same leaf,
	// the claim is refused because the leaf is taken, and the loop breaks
	// having bound nothing. The venue then looks like one that hides its
	// token's identity, and gets dropped from the catalog. That is how the
	// busiest launchpad on the chain went missing.
	for (const leaf of strings) if (eq(leaf.value, facts.name) && claim('name', leaf)) break;
	for (const leaf of strings) if (eq(leaf.value, facts.symbol) && claim('symbol', leaf)) break;

	// Then links, which are unambiguous because their host names are.
	for (const leaf of strings) {
		if (taken.has(leaf.path.join('.')) || !isUrl(leaf.value)) continue;
		if (/(^|\/\/)(www\.)?(x\.com|twitter\.com)\//i.test(leaf.value)) claim('twitter', leaf);
		else if (/(^|\/\/)(www\.)?t\.me\//i.test(leaf.value)) claim('telegram', leaf);
		else if (/discord\.(gg|com)\//i.test(leaf.value)) claim('discord', leaf);
	}

	// Metadata: an image URL points at a picture, a metadata URI does not.
	for (const leaf of strings) {
		if (taken.has(leaf.path.join('.')) || !isUrl(leaf.value)) continue;
		if (IMAGE_EXT.test(leaf.value) || leaf.value.startsWith('data:image')) claim('imageUrl', leaf);
	}
	for (const leaf of strings) {
		if (taken.has(leaf.path.join('.'))) continue;
		if (isUrl(leaf.value) || /^(ipfs:\/\/|baf|Qm)/.test(leaf.value)) {
			if (!claim('metadataUri', leaf)) break;
			// The bytes32 immediately after a metadata URI, in the same tuple,
			// is the hash of the document it points at. Every launchpad here
			// that stores one puts it there. Recognising it matters twice
			// over: the hash gets set to match the document this launch
			// actually publishes, and it stops being mistaken for a CREATE2
			// salt and filled with randomness.
			const sibling = leaves.find((other) =>
				other.type === 'bytes32'
				&& other.path.length === leaf.path.length
				&& other.path.slice(0, -1).join('.') === leaf.path.slice(0, -1).join('.')
				&& other.path.at(-1) === leaf.path.at(-1) + 1);
			if (sibling) claim('metadataHash', sibling);
			break;
		}
	}
	// Whatever remains that reads like a sentence is the description, and a
	// leftover URL is the project's own site.
	for (const leaf of strings) {
		if (taken.has(leaf.path.join('.')) || !leaf.value) continue;
		if (isUrl(leaf.value)) claim('website', leaf);
	}
	// Only once identity is settled. If the token's own name could not be read
	// there is nothing to match it against, and the first plain string in the
	// call is far more likely to *be* the name than to be prose about it.
	// Writing a caller's description into that slot would rename the token.
	const identified = bindings.some((b) => b.role === 'name') && bindings.some((b) => b.role === 'symbol');
	if (identified) {
		for (const leaf of strings) {
			if (taken.has(leaf.path.join('.')) || !leaf.value || isUrl(leaf.value)) continue;
			if (claim('description', leaf)) break;
		}
	}

	// The creator: the address that sent the transaction, wherever it appears.
	if (facts.creator) {
		for (const leaf of leaves) {
			if (leaf.type !== 'address' || taken.has(leaf.path.join('.'))) continue;
			if (eq(leaf.value, facts.creator)) { claim('creator', leaf); break; }
		}
	}

	// A deadline. Every launchpad that takes one compares it against
	// block.timestamp, and the anchor's expired the moment it was mined, so
	// replaying it produces a launch that reverts every single time with
	// nothing in the calldata to say why. It is recognisable because a unix
	// timestamp near the anchor's own block is not a value anything else in a
	// launch would plausibly be.
	if (facts.timestamp) {
		const floor = facts.timestamp - 86_400;
		const ceiling = facts.timestamp + 400 * 86_400;
		for (const leaf of leaves) {
			if (!/^u?int/.test(leaf.type) || taken.has(leaf.path.join('.'))) continue;
			const value = Number(leaf.value ?? 0);
			if (value >= floor && value <= ceiling) { claim('deadline', leaf); break; }
		}
	}

	// Every non-zero bytes32 is a salt candidate. Replaying a real CREATE2 salt
	// is the single most damaging thing a learned descriptor could do, so none
	// of them is left replayed on the strength of its position in the argument
	// list. The live probe decides which ones the venue actually allows a
	// launch to change.
	for (const leaf of leaves) {
		if (leaf.type !== 'bytes32' || taken.has(leaf.path.join('.'))) continue;
		if (!/^0x0+$/.test(String(leaf.value))) claim('salt', leaf);
	}

	return bindings;
}

/**
 * Turn one launcher group into a verified descriptor.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {object} opts.group      A group from `groupByLauncher`.
 * @param {string|null} opts.signature
 * @param {string} [opts.id]
 * @param {string} [opts.label]
 * @returns {Promise<object>} descriptor, or a stub carrying the reason it is unusable
 */
export async function buildDescriptor({ client, group, signature, id, label }) {
	const base = {
		// One contract can expose several launch functions, and they are
		// genuinely different venues to a caller: different arguments, different
		// fee, different pool. The selector is part of the identity.
		id: id || `rhc-${group.address.slice(2, 10).toLowerCase()}-${group.selector.slice(2)}`,
		label: label || null,
		address: group.address,
		chainId: 4663,
		kind: 'launchpad',
		selector: group.selector,
		observed: {
			launches: group.launches.length,
			firstBlock: Number(group.launches[0].blockNumber),
			lastBlock: Number(group.launches[group.launches.length - 1].blockNumber),
		},
		forwarder: group.forwarder,
	};
	if (group.forwarder) return { ...base, usable: false, reason: `calls arrive through ${group.forwarder}, not this venue's own entry point` };
	if (!signature) return { ...base, usable: false, reason: `selector ${group.selector} matches no known function signature` };
	const shape = classifyLaunchFunction(signature);
	if (!shape.launch && !CONFIRMED_ENTRY_POINTS.has(group.address.toLowerCase())) {
		return { ...base, usable: false, signature, reason: shape.reason };
	}

	// Two things decide the anchor, and both are about not overspending.
	//
	// The value sent with a launch is rarely just the fee. Launchpads let a
	// creator buy their own token in the same transaction, and that buy rides
	// along in msg.value: on one venue here the same function was called with
	// 0.0005 ETH and with 0.15 ETH. Replaying the larger one would spend three
	// hundred times the fee on every relayed launch, silently.
	//
	// So the anchor is the most recent launch that paid the least anyone has
	// paid on this venue. That keeps the template and the value coherent (the
	// arguments came from a launch that really did cost that), and it makes
	// the floor, not the ceiling, the default.
	const values = group.launches.map((l) => l.value);
	const minValue = values.reduce((min, v) => (v < min ? v : min));
	const cheapest = group.launches.filter((l) => l.value === minValue);
	const anchor = cheapest[cheapest.length - 1];
	const maxValue = values.reduce((max, v) => (v > max ? v : max));
	let args;
	let types;
	try {
		types = argumentTypes(signature);
		({ args } = decodeFunctionData({ abi: [parseAbiItem(`function ${signature}`)], data: anchor.input }));
	} catch (err) {
		return { ...base, usable: false, reason: `anchor calldata does not decode against ${signature}: ${short(err)}` };
	}

	// Trailing calldata past the ABI payload is valid and common. Recording it
	// separately keeps verification exact without replaying somebody else's
	// referral tag on every launch.
	let trailer = '';
	try {
		const canonical = encodeFunctionData({ abi: [parseAbiItem(`function ${signature}`)], functionName: signature.slice(0, signature.indexOf('(')), args: [...args] });
		if (anchor.input.toLowerCase().startsWith(canonical.toLowerCase())) trailer = `0x${anchor.input.slice(canonical.length)}`;
	} catch { trailer = ''; }

	// Identity is matched by value, so the token's own name and symbol are the
	// whole basis of inference. A transient RPC failure here used to look
	// exactly like a venue that hides its identity, and quietly demoted the
	// busiest launchpad on the chain. It is now its own outcome, and it is
	// retried before it becomes one.
	// The anchor's block time, which is what makes a deadline recognisable.
	const anchorBlock = await client.getBlock({ blockNumber: anchor.blockNumber }).catch(() => null);
	const facts = { creator: anchor.from, timestamp: anchorBlock ? Number(anchorBlock.timestamp) : null };
	for (const field of ['name', 'symbol']) {
		facts[field] = await readWithRetry(client, anchor.token, field);
	}
	if (!facts.name || !facts.symbol) {
		return { ...base, signature, usable: false, reason: `could not read the anchor token's ${!facts.name ? 'name' : 'symbol'}() from chain, so nothing could be matched against it; rerun discovery` };
	}
	const decimals = await client.readContract({ address: anchor.token, abi: erc20Abi, functionName: 'decimals' }).catch(() => null);

	const descriptor = {
		...base,
		usable: true,
		implementation: await readImplementation(client, group.address),
		launch: {
			signature,
			selector: group.selector,
			value: minValue.toString(),
			valueObserved: { min: minValue.toString(), max: maxValue.toString(), samples: values.length },
			template: dehydrate([...args]),
			bindings: inferBindings({ args: [...args], types, facts }),
		},
		evidence: {
			txHash: anchor.txHash,
			blockNumber: Number(anchor.blockNumber),
			token: anchor.token,
			name: facts.name,
			symbol: facts.symbol,
			decimals: decimals === null ? null : Number(decimals),
			creator: anchor.from,
			input: anchor.input,
			trailer: trailer && trailer !== '0x' ? trailer : undefined,
		},
	};

	const check = verifyDescriptor(descriptor);
	if (!check.ok) return { ...base, usable: false, reason: check.reason };

	// Two rules that turn a descriptor which merely encodes into one that can
	// safely launch something new. Both were written after watching a live
	// simulation revert for exactly these reasons.
	//
	// Identity: if the token's name and symbol are not visible in the calldata
	// they are inside an opaque `bytes` blob, and a launch here would ship
	// under the anchor token's name. Launching somebody else's ticker is not a
	// degraded launch, it is the wrong one.
	const roles = new Set(descriptor.launch.bindings.map((b) => b.role));
	if (!roles.has('name') || !roles.has('symbol')) {
		return { ...base, signature, usable: false, reason: 'the token name and symbol are not visible in this venue\'s calldata, so a launch here would reuse the anchor token\'s identity' };
	}
	// A launchpad often carries several bytes32 arguments and only one of them
	// is a salt; the others are commitments the contract recomputes. Nothing in
	// the ABI says which, so the count is recorded rather than guessed at.
	// `probeDescriptor` settles it against the live contract, and a plan-time
	// simulation catches it either way before anything is signed.
	const opaque = [...walkLeaves([...args], `(${types.join(',')})`, [])]
		.filter((leaf) => leaf.type === 'bytes32' && !/^0x0+$/.test(String(leaf.value)));
	if (opaque.length > 1) descriptor.ambiguousSalt = opaque.length;

	// Curated knowledge is folded in last and re-verified, so an override can
	// never be the reason a descriptor stops reproducing its own anchor.
	const enriched = applyOverride(descriptor, (path) => readPath(descriptor.launch.template, path) !== undefined);
	const recheck = verifyDescriptor(enriched);
	if (!recheck.ok) return { ...base, usable: false, reason: `curated override broke verification: ${recheck.reason}` };
	return enriched;
}

/** EIP-1967 implementation slot, and the EIP-1167 minimal-proxy body. */
const EIP1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MINIMAL_PROXY = /363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i;

/**
 * Most launchpads here sit behind a proxy. Recording the implementation makes
 * an upgrade visible: the catalog's implementation stops matching the chain's,
 * which is the signal to re-learn the descriptor rather than keep replaying a
 * template the new code may read differently.
 */
export async function readImplementation(client, address) {
	const code = await client.getCode({ address }).catch(() => null);
	if (!code || code.length <= 2) return null;
	const minimal = MINIMAL_PROXY.exec(code);
	if (minimal) return getAddress(`0x${minimal[1]}`);
	const slot = await client.getStorageAt({ address, slot: EIP1967_SLOT }).catch(() => null);
	if (!slot) return null;
	const candidate = `0x${slot.slice(26)}`;
	return candidate === ZERO_ADDRESS ? null : getAddress(candidate);
}

const short = (err) => String(err?.shortMessage || err?.message || err).split('\n')[0].slice(0, 160);

/** A public RPC answers 429 often enough that one attempt is not an answer. */
async function readWithRetry(client, address, functionName, attempts = 4) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await client.readContract({ address, abi: erc20Abi, functionName });
		} catch (err) {
			// A contract that does not implement the function will never
			// implement it, so there is nothing to wait for.
			if (/reverted|does not exist|returned no data/i.test(String(err?.shortMessage || err?.message || ''))) return null;
			if (attempt === attempts - 1) return null;
			await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
		}
	}
	return null;
}

/**
 * Build launcher groups from an explicit list of launch transactions.
 *
 * A block scan only sees the window it scanned, and a venue that launched
 * thirty tokens last quarter and none this week is not less real for it. Seed
 * transactions pin those venues into the catalog without widening the scan to
 * the whole chain, which on a network producing a block every fraction of a
 * second is not a practical rebuild.
 *
 * Nothing is taken on trust: each seed is re-read from the chain, its minted
 * token is resolved from its own receipt, and the descriptor built from it
 * still has to reproduce its calldata before it is usable.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {string[]} opts.txHashes
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<Array<object>>}
 */
export async function groupsFromTransactions({ client, txHashes, onProgress }) {
	const groups = new Map();
	let seen = 0;
	for (const hash of txHashes) {
		seen++;
		const [tx, receipt] = await Promise.all([
			client.getTransaction({ hash }).catch(() => null),
			client.getTransactionReceipt({ hash }).catch(() => null),
		]);
		if (!tx?.to || !receipt || receipt.status !== 'success') continue;
		const token = mintedTokenFromLogs(receipt.logs);
		if (!token) continue;
		const address = getAddress(tx.to);
		const selector = tx.input.slice(0, 10);
		const key = `${address.toLowerCase()}:${selector}`;
		if (!groups.has(key)) groups.set(key, { address, selector, launches: [], forwarder: CALL_FORWARDERS[address.toLowerCase()] || null });
		groups.get(key).launches.push({
			token, txHash: hash, blockNumber: BigInt(receipt.blockNumber), from: getAddress(tx.from), value: tx.value, input: tx.input,
		});
		if (seen % 20 === 0) onProgress?.(`read ${seen}/${txHashes.length} seed transaction(s)`);
	}
	for (const group of groups.values()) group.launches.sort((a, b) => Number(a.blockNumber - b.blockNumber));
	return [...groups.values()];
}

/**
 * Merge groups that describe the same (contract, selector), so a venue found
 * by both the scan and a seed is one entry with both sets of evidence.
 *
 * @param {...Array<object>} sets
 */
export function mergeGroups(...sets) {
	const merged = new Map();
	for (const set of sets) {
		for (const group of set) {
			const key = `${group.address.toLowerCase()}:${group.selector}`;
			const existing = merged.get(key);
			if (!existing) { merged.set(key, { ...group, launches: [...group.launches] }); continue; }
			const seen = new Set(existing.launches.map((l) => l.txHash));
			for (const launch of group.launches) if (!seen.has(launch.txHash)) existing.launches.push(launch);
		}
	}
	for (const group of merged.values()) group.launches.sort((a, b) => Number(a.blockNumber - b.blockNumber));
	return [...merged.values()].sort((a, b) => b.launches.length - a.launches.length);
}

/** The ERC-20 in a receipt that minted supply from the zero address. */
export function mintedTokenFromLogs(logs) {
	for (const log of logs || []) {
		if (log.topics?.[0] !== TRANSFER_TOPIC) continue;
		if (log.topics.length !== 3 || log.topics[1] !== ZERO_TOPIC) continue;
		if (!log.data || log.data === '0x') continue;
		return getAddress(log.address);
	}
	return null;
}

/**
 * Send one venue a launch it would really accept, and see what it says.
 *
 * A one-shot liveness check for a single venue, in one call: fresh identity,
 * fresh salt, a probe account funded only inside the simulation. Useful for
 * asking "would this venue take a launch right now" without the per-binding
 * work `probeDescriptor` does.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {object} opts.descriptor
 * @param {string} [opts.probe]      Address to simulate from.
 * @returns {Promise<{ok: boolean, reason?: string, checkedAt: string}>}
 */
export async function simulateLaunch({ client, descriptor, probe = '0x000000000000000000000000000000000000dEaD' }) {
	const checkedAt = new Date().toISOString();
	if (!descriptor.usable) return { ok: false, reason: descriptor.reason, checkedAt };
	const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
	const spec = {
		name: `Probe ${suffix}`,
		symbol: `PROBE${suffix}`,
		description: 'catalog liveness probe',
		imageUrl: 'https://example.invalid/probe.png',
		links: {},
	};
	const { metadataURI, metadataHash } = await inlineMetadataHost().publish(spec);
	const call = encodeLaunchCall(descriptor, {
		name: spec.name,
		symbol: spec.symbol,
		description: spec.description,
		imageUrl: spec.imageUrl,
		metadataUri: metadataURI,
		metadataHash,
		creator: probe,
		salt: randomBytes32(),
	});
	try {
		await client.simulateContract({
			...call,
			account: probe,
			// A hundred ETH inside the simulation only. It funds the launch fee
			// and the gas so the check measures the venue, not the probe.
			stateOverride: [{ address: probe, balance: 100n * 10n ** 18n }],
		});
		return { ok: true, checkedAt };
	} catch (err) {
		const signature = revertSignature(err);
		const message = short(err);
		return { ok: false, reason: signature ? `${message} (${signature})` : message, checkedAt };
	}
}

/**
 * Walk a viem error chain for the revert's four-byte selector.
 *
 * Which field carries it depends on how the call was made: a typed
 * `simulateContract` surfaces `signature`, while a raw `call` surfaces the
 * revert data itself. Reading only the first is how a whole catalog ends up
 * saying "reverted for an unknown reason" when every one of those reverts had
 * a name sitting one field away.
 */
function revertSignature(err) {
	for (let e = err, i = 0; e && i < 10; e = e.cause, i++) {
		if (e.signature) return e.signature;
		const data = typeof e.data === 'string' ? e.data : e.data?.data;
		if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)) return data.slice(0, 10).toLowerCase();
	}
	return null;
}

/**
 * A synthetic account discovery simulates from.
 *
 * It holds nothing and no key exists for it. Every probe runs through
 * `eth_call` with a state override that gives it a balance for the duration of
 * that one call, so nothing is ever funded and nothing can be sent.
 */
export const PROBE_ACCOUNT = '0x1111111111111111111111111111111111111111';
const PROBE_BALANCE = 10n ** 20n;

const PROBE_SPEC = Object.freeze({
	name: 'Probe Launch',
	symbol: 'PROBE',
	description: 'a simulated launch, never sent',
	imageUrl: 'https://example.invalid/probe.png',
	twitter: '',
	telegram: '',
	website: '',
	discord: '',
});

/**
 * Prove, against the live contract, that the fields a descriptor claims to
 * fill in can actually be filled in.
 *
 * Re-encoding an anchor transaction proves the ABI was read correctly. It
 * proves nothing about substitution, and substitution is the entire point: a
 * launch changes those leaves. The two are genuinely different questions, and
 * assuming the first answers the second is wrong in a way that costs money.
 *
 * A real example from this chain, and the reason this function exists. One
 * venue's launch call carries two `bytes32` arguments. Inference called the
 * first one a salt, because it was not zero and salts are bytes32. It is not a
 * salt; it is a commitment to a launch configuration the venue publishes, and
 * replacing it reverts with `LaunchEconomicsMismatch`. The second one is the
 * salt. Nothing in the ABI, the argument order, or the anchor's values says
 * which is which. One `eth_call` each says it immediately.
 *
 * So every binding is tested. What survives is what a launch is allowed to
 * change; what does not is pruned back to being replayed, with the revert that
 * pruned it recorded. A venue whose identity fields cannot even be substituted
 * is not launchable at all, and says so.
 *
 * @param {object} opts
 * @param {import('viem').PublicClient} opts.client
 * @param {object} opts.descriptor
 * @param {string} [opts.account]
 * @returns {Promise<object>} the descriptor, with `probe` recorded and bindings pruned
 */
export async function probeDescriptor({ client, descriptor, account = PROBE_ACCOUNT }) {
	if (!descriptor.usable) return descriptor;

	const values = probeValues(descriptor);
	// A launchpad whose entry point takes an opening buy pulls an ERC-20 from
	// the caller. The probe holds nothing, so without this every one of those
	// venues reverts with an allowance error and gets written off as broken
	// when it is merely a venue the probe cannot afford. Giving the probe a
	// balance and an allowance for every token the anchor call names, inside
	// the simulation only, measures the venue instead of the probe.
	const funding = await fundingOverrides({ client, descriptor, account });
	const simulate = async (bindings, extra = {}) => {
		const candidate = { ...descriptor, launch: { ...descriptor.launch, bindings } };
		let data;
		try {
			// A fresh salt every time: two probes of the same venue must not
			// collide with each other any more than with the anchor.
			data = encodeLaunchCall(candidate, { ...values, salt: randomBytes32(), ...extra }).data;
		} catch (err) {
			return { ok: false, revert: null, detail: `arguments did not encode: ${short(err)}` };
		}
		try {
			await client.call({
				account, to: getAddress(descriptor.address), data,
				value: BigInt(descriptor.launch.value || 0),
				stateOverride: [{ address: account, balance: PROBE_BALANCE }, ...funding],
			});
			return { ok: true };
		} catch (err) {
			return { ok: false, revert: revertSignature(err), detail: short(err) };
		}
	};

	const all = descriptor.launch.bindings || [];
	const salts = all.filter((b) => b.role === 'salt');
	// A deadline belongs in the baseline for the same reason a salt does, and
	// more absolutely: the anchor's expired when it was mined, so a baseline
	// that replays it fails on every venue that takes one. PAIR is the proof.
	// Its launch is perfectly drivable and the probe called it broken, because
	// the only thing wrong was a timestamp from an hour ago.
	const deadlines = all.filter((b) => b.role === 'deadline');
	const rest = all.filter((b) => b.role !== 'salt' && b.role !== 'deadline');
	const identity = [...rest.filter((b) => b.role === 'name' || b.role === 'symbol'), ...deadlines];
	const rejected = [];

	// Salts come first, before anything else can be tested.
	//
	// A venue that deploys with CREATE2 derives the token address from its
	// salt, so replaying the anchor's salt collides with the token that launch
	// already created and reverts. Checking identity with the salt untouched
	// would therefore fail on every CREATE2 launchpad on the chain, and the
	// catalog would conclude they are all unlaunchable when the truth is the
	// opposite: they are the ones that most need a fresh salt.
	//
	// So the baseline randomises every candidate. If that fails, each is tried
	// alone, which separates a real salt from a commitment the contract
	// recomputes and checks. If none of them can be randomised, the anchor's
	// values are kept and the reason is recorded.
	let base = [...identity, ...salts];
	let saltCheck = await simulate(base);
	if (!saltCheck.ok && salts.length) {
		const free = [];
		for (const binding of salts) {
			const check = await simulate([...identity, binding]);
			if (check.ok) free.push(binding);
			else rejected.push({ role: 'salt', path: binding.path, revert: check.revert || null, detail: check.detail, note: 'this bytes32 is constrained by the venue, so it is replayed rather than randomised' });
		}
		base = [...identity, ...free];
		saltCheck = await simulate(base);
	}

	// Still failing? The venue may be pulling an opening buy the probe cannot
	// fund. Several launchpads here take a "launch and buy" entry point where
	// the buy amount is an ordinary uint in the calldata, indistinguishable
	// from a fee or a deadline by type alone, and the whole call reverts with
	// an allowance error before anything else can be learned.
	//
	// Zeroing the numeric arguments nobody has claimed turns that into the
	// minimal launch: no buy, no allowance needed. If that simulates, those
	// arguments were the buy, and they become fields a caller sets rather than
	// values inherited from whoever the anchor happened to be. If it does not,
	// nothing was learned and nothing is bound.
	if (!saltCheck.ok) {
		const amounts = amountCandidates(descriptor, all);
		if (amounts.length) {
			const withZeroed = [...base, ...amounts];
			const zeroCheck = await simulate(withZeroed);
			if (zeroCheck.ok) {
				base = withZeroed;
				saltCheck = zeroCheck;
			} else {
				const free = [];
				for (const binding of amounts) {
					const check = await simulate([...base, binding]);
					if (check.ok) free.push(binding);
				}
				if (free.length) {
					const combined = await simulate([...base, ...free]);
					if (combined.ok) {
						base = [...base, ...free];
						saltCheck = combined;
					}
				}
			}
		}
	}

	// The venue has to accept a launch under a different name before anything
	// else is worth testing.
	if (!saltCheck.ok) {
		return {
			...descriptor,
			usable: false,
			reason: `a substituted launch reverts even with only the name, symbol and deadline changed: ${saltCheck.detail}${saltCheck.revert ? ` (${saltCheck.revert})` : ''}`,
			probe: { ok: false, account, at: new Date().toISOString(), revert: saltCheck.revert || null, rejected: rejected.length ? rejected : undefined },
		};
	}

	// Then the rest, added one at a time and kept only if the venue takes them.
	const accepted = [...base];
	for (const binding of rest) {
		if (accepted.includes(binding)) continue;
		const check = await simulate([...accepted, binding]);
		if (check.ok) accepted.push(binding);
		else rejected.push({ role: binding.role, path: binding.path, revert: check.revert || null, detail: check.detail });
	}

	const final = await simulate(accepted);
	return {
		...descriptor,
		usable: final.ok,
		reason: final.ok ? undefined : `the accepted substitutions still revert together: ${final.detail}${final.revert ? ` (${final.revert})` : ''}`,
		launch: { ...descriptor.launch, bindings: accepted },
		probe: {
			ok: final.ok,
			account,
			at: new Date().toISOString(),
			accepted: accepted.map((b) => b.role),
			rejected: rejected.length ? rejected : undefined,
		},
	};
}

/**
 * Balance and allowance overrides for every ERC-20 the anchor call names.
 *
 * Which argument is the quote asset is not knowable from types alone, so every
 * address in the call is tested for being an ERC-20 and funded if it is. The
 * overrides last exactly one `eth_call`; nothing is ever funded on chain.
 */
async function fundingOverrides({ client, descriptor, account }) {
	const types = argumentTypes(descriptor.launch.signature);
	const seen = new Set();
	const overrides = [];
	for (let i = 0; i < types.length; i++) {
		for (const leaf of walkLeaves(descriptor.launch.template[i], types[i], [i])) {
			if (leaf.type !== 'address' || typeof leaf.value !== 'string') continue;
			const address = leaf.value.toLowerCase();
			if (seen.has(address) || /^0x0+$/.test(address)) continue;
			seen.add(address);
			try {
				if (!(await isErc20(client, leaf.value))) continue;
				overrides.push(...(await fundOverride({ client, token: leaf.value, holder: account, spender: descriptor.address })));
			} catch {
				// A token whose layout cannot be measured is simply not funded.
			}
		}
	}
	return overrides;
}

/**
 * Unclaimed, non-zero integer arguments: the places an opening buy can hide.
 *
 * Bound as `buyAmount`, which defaults to zero everywhere in this toolkit, so
 * a caller who wants to buy their own token asks for it and nobody inherits
 * the anchor's.
 */
function amountCandidates(descriptor, bindings) {
	const taken = new Set(bindings.map((b) => b.path.join('.')));
	const types = argumentTypes(descriptor.launch.signature);
	const template = descriptor.launch.template;
	const out = [];
	for (let i = 0; i < types.length; i++) {
		for (const leaf of walkLeaves(template[i], types[i], [i])) {
			if (!/^u?int(8|16|24|32|64|96|128|160|256)?$/.test(leaf.type)) continue;
			if (taken.has(leaf.path.join('.'))) continue;
			if (!leaf.value || String(leaf.value) === '0') continue;
			out.push({ role: 'buyAmount', path: leaf.path, type: leaf.type });
		}
	}
	return out;
}

/** Values a probe substitutes: a plausible launch that is not the anchor's. */
function probeValues(descriptor) {
	const document = JSON.stringify({ name: PROBE_SPEC.name, symbol: PROBE_SPEC.symbol, description: PROBE_SPEC.description, image: PROBE_SPEC.imageUrl });
	const metadataUri = `data:application/json;base64,${toBase64(document)}`;
	return {
		...PROBE_SPEC,
		metadataUri,
		metadataHash: keccak256(stringToBytes(document)),
		creator: PROBE_ACCOUNT,
		// A replayed deadline is always in the past, so a probe that reused it
		// would report every venue with one as broken.
		deadline: Math.floor(Date.now() / 1000) + 600,
		// No opening buy. A launch that also buys its own token pulls an ERC-20
		// from the caller, which a probe account cannot hold, and which nobody
		// should inherit by default from whoever the anchor happened to be.
		// The minimal launch is the one worth proving.
		buyAmount: '0',
	};
}

function randomBytes32() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

