// Venue descriptors: how one launchpad's launch function is called.
//
// Robinhood Chain has dozens of launchpads and no two share an ABI. Writing an
// adapter per venue by hand does not scale past the handful that publish their
// contracts, and guessing at the arguments of a contract that spends money is
// worse than not supporting it at all.
//
// So a descriptor is not written, it is *observed*. Every descriptor is
// anchored to one real transaction that successfully launched a real token on
// that venue, decoded into a template of arguments. A launch reuses that
// template verbatim and substitutes only the leaves whose meaning is known:
// the name, the symbol, the metadata, the creator, the salt. Everything else
// keeps the value that already worked on chain.
//
// Two properties fall out of that, and both matter more than elegance:
//
//   1. Nothing is invented. A field this code does not understand is not
//      guessed at, defaulted, or zeroed; it is replayed.
//   2. The encoder is falsifiable. `verifyDescriptor` re-encodes the anchor
//      transaction from its own template and asserts the calldata matches the
//      chain byte for byte. A descriptor that cannot reproduce the launch it
//      was learned from is rejected before it can spend anything.
//
// Substituted values still change the call, so a descriptor is a starting
// point and not a proof of the next launch. That is what simulation is for:
// every target built on a descriptor simulates before it signs.

import { encodeFunctionData, parseAbiItem } from 'viem';

/**
 * The fields a launch can fill in. Anything outside this list is replayed from
 * the anchor transaction untouched.
 *
 * Two of these must never be replayed. `salt`, because launchpads that deploy
 * with CREATE2 derive the token address from it, so reusing the anchor's salt
 * either reverts on an address collision or mines the same vanity suffix as
 * someone else's token. And `deadline`, because the anchor's expired the
 * moment it was mined: a replayed deadline is a launch that reverts every
 * time, forever, for a reason nothing in the calldata makes obvious.
 */
export const LAUNCH_ROLES = Object.freeze([
	'name',
	'symbol',
	'description',
	'imageUrl',
	'metadataUri',
	'metadataHash',
	'twitter',
	'telegram',
	'website',
	'discord',
	'creator',
	'salt',
	'deadline',
	'quoteToken',
	'buyAmount',
]);

/** Roles whose value the caller supplies; the rest are derived or replayed. */
export const CALLER_ROLES = Object.freeze(LAUNCH_ROLES.filter((r) => r !== 'salt' && r !== 'deadline'));

/** Roles this toolkit always regenerates, because the anchor's value is dead on arrival. */
export const REGENERATED_ROLES = Object.freeze(['salt', 'deadline']);

/** @param {unknown} value */
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Split an ABI type into its element type and array suffix, so a template can
 * be walked alongside the types it was decoded with.
 *
 * @param {string} type
 * @returns {{base: string, array: boolean, fixedLength: number|null}}
 */
export function splitType(type) {
	const match = /^(.*)\[(\d*)\]$/.exec(type);
	if (!match) return { base: type, array: false, fixedLength: null };
	return { base: match[1], array: true, fixedLength: match[2] ? Number(match[2]) : null };
}

/**
 * Turn a tuple type string into its component types. `(string,uint256)` gives
 * `['string', 'uint256']`, respecting nesting.
 *
 * @param {string} type
 * @returns {string[]}
 */
export function tupleComponents(type) {
	if (!type.startsWith('(') || !type.endsWith(')')) throw new Error(`not a tuple type: ${type}`);
	const inner = type.slice(1, -1);
	if (!inner) return [];
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			parts.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(inner.slice(start));
	return parts.map((p) => p.trim());
}

/**
 * Argument types of a flat signature, in order.
 *
 * @param {string} signature e.g. `launchToken((string,string),uint256)`
 * @returns {string[]}
 */
export function argumentTypes(signature) {
	const open = signature.indexOf('(');
	if (open < 0) throw new Error(`signature has no argument list: ${signature}`);
	return tupleComponents(signature.slice(open));
}

/** @param {string} signature */
export function functionName(signature) {
	const open = signature.indexOf('(');
	return open < 0 ? signature : signature.slice(0, open);
}

/** The parsed viem ABI item for a descriptor's launch function. */
export function launchAbi(descriptor) {
	return [parseAbiItem(`function ${descriptor.launch.signature}`)];
}

/**
 * JSON cannot hold a bigint, so a stored template keeps integers as decimal
 * strings and bytes as hex. Rehydration walks the value alongside its ABI type
 * and restores exactly the JavaScript types viem's encoder expects.
 *
 * @param {string} type
 * @param {any} value
 */
export function hydrate(type, value) {
	const { base, array } = splitType(type);
	if (array) {
		if (!Array.isArray(value)) throw new Error(`expected an array for ${type}`);
		return value.map((item) => hydrate(base, item));
	}
	if (base.startsWith('(')) {
		const components = tupleComponents(base);
		if (!Array.isArray(value)) throw new Error(`expected a tuple for ${base}`);
		return components.map((component, i) => hydrate(component, value[i]));
	}
	if (/^u?int\d*$/.test(base)) return BigInt(value);
	if (base === 'bool') return typeof value === 'boolean' ? value : value === 'true';
	return value;
}

/** The inverse of `hydrate`: a JSON-safe copy of a decoded argument tree. */
export function dehydrate(value) {
	if (typeof value === 'bigint') return value.toString();
	if (Array.isArray(value)) return value.map(dehydrate);
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dehydrate(v)]));
	}
	return value;
}

/**
 * Read the leaf a binding path points at.
 *
 * @param {any[]} tree
 * @param {number[]} path
 */
export function readPath(tree, path) {
	let node = tree;
	for (const step of path) {
		if (node == null) return undefined;
		node = node[step];
	}
	return node;
}

/**
 * Write a leaf without mutating the template, so one descriptor can serve
 * concurrent launches.
 *
 * @param {any[]} tree
 * @param {number[]} path
 * @param {any} value
 */
export function writePath(tree, path, value) {
	if (!path.length) return value;
	const copy = Array.isArray(tree) ? tree.slice() : [];
	const [head, ...rest] = path;
	copy[head] = rest.length ? writePath(copy[head], rest, value) : value;
	return copy;
}

/**
 * Build the argument tree for a launch: the anchor template with every bound
 * role replaced by the caller's value.
 *
 * A role whose value is null or undefined keeps the template's value. That is
 * deliberate: a venue whose anchor launch carried an empty Telegram link and a
 * caller who has no Telegram link agree, and a venue whose anchor carried a
 * required field this caller cannot supply still gets something that worked.
 *
 * @param {object} descriptor
 * @param {Record<string, any>} values Keyed by role.
 * @returns {any[]}
 */
export function buildArgs(descriptor, values = {}) {
	const types = argumentTypes(descriptor.launch.signature);
	let args = types.map((type, i) => hydrate(type, descriptor.launch.template[i]));
	for (const binding of descriptor.launch.bindings || []) {
		const value = values[binding.role];
		if (value === undefined || value === null) continue;
		args = writePath(args, binding.path, hydrate(binding.type, coerce(binding.type, value)));
	}
	return args;
}

/** Accept the shapes a caller naturally has for a binding's ABI type. */
function coerce(type, value) {
	const { base, array } = splitType(type);
	if (array || base.startsWith('(')) return value;
	if (/^u?int\d*$/.test(base)) return typeof value === 'bigint' ? value.toString() : String(value);
	if (base === 'address') return String(value);
	return value;
}

/**
 * The complete call a launch sends: address, ABI, arguments and value.
 *
 * @param {object} descriptor
 * @param {Record<string, any>} values
 */
export function encodeLaunchCall(descriptor, values = {}) {
	const abi = launchAbi(descriptor);
	const args = buildArgs(descriptor, values);
	return {
		address: descriptor.address,
		abi,
		functionName: functionName(descriptor.launch.signature),
		args,
		value: BigInt(descriptor.launch.value ?? '0'),
		data: encodeFunctionData({ abi, functionName: functionName(descriptor.launch.signature), args }),
	};
}

/**
 * Prove a descriptor against the transaction it was learned from.
 *
 * Encoding the untouched template must reproduce that transaction's calldata
 * exactly. If it does not, the signature is wrong, the decode lost something,
 * or the template was edited by hand, and the descriptor must not be used to
 * build a transaction that spends money.
 *
 * @param {object} descriptor
 * @returns {{ok: boolean, reason?: string, encoded?: string, expected?: string}}
 */
export function verifyDescriptor(descriptor) {
	const expected = descriptor.evidence?.input;
	if (!expected) return { ok: false, reason: 'descriptor carries no anchor calldata to verify against' };
	let encoded;
	try {
		encoded = encodeLaunchCall(descriptor).data;
	} catch (err) {
		return { ok: false, reason: `template does not encode: ${String(err?.shortMessage || err?.message || err).split('\n')[0]}` };
	}
	// Some callers append bytes after the ABI payload: a referral tag, a
	// frontend marker, an affiliate id. The EVM ignores trailing calldata, so
	// those launches are perfectly valid and their canonical encoding is a
	// strict prefix of what was sent. The trailer is recorded on the
	// descriptor and deliberately not replayed, because it is somebody else's
	// tag and re-sending it would credit them for your launch.
	const trailer = (descriptor.evidence.trailer || '').replace(/^0x/, '');
	const canonical = expected.toLowerCase().slice(0, expected.length - trailer.length);
	if (encoded.toLowerCase() !== canonical) {
		return { ok: false, reason: 're-encoded calldata does not match the anchor transaction', encoded, expected: canonical };
	}
	if (trailer && `${canonical}${trailer.toLowerCase()}` !== expected.toLowerCase()) {
		return { ok: false, reason: 'recorded trailing calldata does not match the anchor transaction' };
	}
	for (const binding of descriptor.launch.bindings || []) {
		const leaf = readPath(descriptor.launch.template, binding.path);
		if (leaf === undefined) return { ok: false, reason: `binding for "${binding.role}" points outside the template` };
		if (!LAUNCH_ROLES.includes(binding.role)) return { ok: false, reason: `unknown role "${binding.role}"` };
	}
	return { ok: true };
}

/** Human-readable lines describing what a launch on this venue will send. */
export function describeBindings(descriptor) {
	const bound = new Map((descriptor.launch.bindings || []).map((b) => [b.role, b]));
	const lines = [];
	for (const role of LAUNCH_ROLES) {
		const binding = bound.get(role);
		// Bracketed, not dotted: `0.10` reads as either [0][10] or [0][1][0],
		// and one of those is a different argument entirely.
		if (binding) lines.push(`${role.padEnd(13)} arg ${binding.path.map((step) => `[${step}]`).join('')} (${binding.type})`);
	}
	const total = argumentTypes(descriptor.launch.signature).length;
	lines.push(`replayed      ${countLeaves(descriptor.launch.template) - bound.size} leaf value(s) across ${total} argument(s), from ${descriptor.evidence.txHash}`);
	return lines;
}

function countLeaves(node) {
	if (!Array.isArray(node)) return 1;
	return node.reduce((sum, child) => sum + countLeaves(child), 0);
}
