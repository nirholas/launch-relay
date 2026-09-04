import { describe, expect, it } from 'vitest';
import anchor from './fixtures/venue-anchor.json' with { type: 'json' };
import {
	PROBE_ACCOUNT, classifyLaunchFunction, inferBindings, lookupSignatures, mergeGroups, mintedTokenFromLogs,
	probeDescriptor, simulateLaunch, walkLeaves,
} from '../src/chains/robinhood/discover.js';
import { CALLER_ROLES, REGENERATED_ROLES, argumentTypes } from '../src/chains/robinhood/venues/descriptor.js';
import { VENUE_OVERRIDES, applyOverride } from '../src/chains/robinhood/venues/overrides.js';
import {
	clearSlotCache, findErc20Slots, fundOverride, isErc20, mappingSlot, nestedMappingSlot,
} from '../src/chains/robinhood/erc20-slots.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = `0x${'0'.repeat(64)}`;

describe('walking an argument tree', () => {
	it('yields every leaf with its path and type', () => {
		const leaves = [...walkLeaves(['a', [1n, '0xabc']], '(string,(uint256,address))', [0])];
		expect(leaves).toEqual([
			{ path: [0, 0], type: 'string', value: 'a' },
			{ path: [0, 1, 0], type: 'uint256', value: 1n },
			{ path: [0, 1, 1], type: 'address', value: '0xabc' },
		]);
	});

	it('walks arrays', () => {
		const leaves = [...walkLeaves([[1n, 2n]], '(uint8[])', [0])];
		expect(leaves.map((l) => l.path)).toEqual([[0, 0, 0], [0, 0, 1]]);
	});
});

describe('inferring what a launch argument means', () => {
	const types = argumentTypes('launch((string,string,string,string,address,bytes32))');
	const facts = { name: 'Loop Rat', symbol: 'LOOPRAT', creator: '0x1111111111111111111111111111111111111111' };
	const args = [[
		'Loop Rat',
		'LOOPRAT',
		'ipfs://bafkreiabc',
		'https://x.com/looprat',
		'0x1111111111111111111111111111111111111111',
		'0x2222222222222222222222222222222222222222222222222222222222222222',
	]];

	it('matches identity by value, not by position', () => {
		const bindings = inferBindings({ args, types, facts });
		const byRole = Object.fromEntries(bindings.map((b) => [b.role, b.path.join('.')]));
		expect(byRole.name).toBe('0.0');
		expect(byRole.symbol).toBe('0.1');
		expect(byRole.metadataUri).toBe('0.2');
		expect(byRole.twitter).toBe('0.3');
		expect(byRole.creator).toBe('0.4');
		expect(byRole.salt).toBe('0.5');
	});

	it('never leaves a salt replayed', () => {
		const bindings = inferBindings({ args, types, facts });
		expect(bindings.some((b) => b.role === 'salt')).toBe(true);
	});

	it('does not invent a salt where there is none', () => {
		const zeroSalt = [[...args[0].slice(0, 5), `0x${'0'.repeat(64)}`]];
		const bindings = inferBindings({ args: zeroSalt, types, facts });
		expect(bindings.some((b) => b.role === 'salt')).toBe(false);
	});

	it('binds nothing it cannot recognise', () => {
		const bindings = inferBindings({ args, types, facts: {} });
		expect(bindings.map((b) => b.role).sort()).toEqual(['metadataUri', 'salt', 'twitter']);
	});

	it('tells an image apart from a metadata document', () => {
		const withImage = [['Loop Rat', 'LOOPRAT', 'https://cdn.example/logo.png', '', '0x0', `0x${'0'.repeat(64)}`]];
		const bindings = inferBindings({ args: withImage, types, facts });
		expect(bindings.find((b) => b.role === 'imageUrl')?.path).toEqual([0, 2]);
	});

	it('reproduces the bindings of the real anchor', () => {
		const bindings = inferBindings({
			args: [anchor.launch.template[0], 0n, 0n, anchor.launch.template[3]],
			types: argumentTypes(anchor.launch.signature),
			facts: { name: anchor.evidence.name, symbol: anchor.evidence.symbol, creator: anchor.evidence.creator },
		});
		expect(bindings.map((b) => b.role).sort()).toEqual(anchor.launch.bindings.map((b) => b.role).sort());
	});
});

describe('merging launcher groups', () => {
	const group = (address, selector, hashes) => ({
		address, selector, forwarder: null,
		launches: hashes.map((txHash, i) => ({ txHash, blockNumber: BigInt(i + 1), value: 0n, input: '0x', from: '0x0', token: '0x0' })),
	});

	it('joins the same contract and selector, dropping duplicates', () => {
		const merged = mergeGroups([group('0xA', '0x11', ['0x1', '0x2'])], [group('0xA', '0x11', ['0x2', '0x3'])]);
		expect(merged).toHaveLength(1);
		expect(merged[0].launches.map((l) => l.txHash)).toEqual(['0x1', '0x2', '0x3']);
	});

	it('keeps different selectors on the same contract apart', () => {
		const merged = mergeGroups([group('0xA', '0x11', ['0x1'])], [group('0xA', '0x22', ['0x2'])]);
		expect(merged).toHaveLength(2);
	});

	it('ranks by how many launches a venue actually produced', () => {
		const merged = mergeGroups([group('0xA', '0x11', ['0x1'])], [group('0xB', '0x22', ['0x2', '0x3'])]);
		expect(merged[0].address).toBe('0xB');
	});
});

describe('finding the token in a receipt', () => {
	it('takes the ERC-20 that minted from nothing', () => {
		const token = mintedTokenFromLogs([
			{ address: '0x1111111111111111111111111111111111111111', topics: ['0xdead'], data: '0x01' },
			{ address: '0x2222222222222222222222222222222222222222', topics: [TRANSFER, ZERO, ZERO], data: '0x01' },
		]);
		expect(token).toBe('0x2222222222222222222222222222222222222222');
	});

	it('ignores an ERC-721 mint, which shares the topic', () => {
		expect(mintedTokenFromLogs([{ address: '0x33', topics: [TRANSFER, ZERO, ZERO, ZERO], data: '0x' }])).toBeNull();
	});

	it('returns null when nothing was minted', () => {
		expect(mintedTokenFromLogs([])).toBeNull();
	});
});

describe('signature lookup', () => {
	it('prefers a candidate attached to a verified contract', async () => {
		const fetchImpl = async () => ({
			ok: true,
			json: async () => ({ result: { function: { '0xaabbccdd': [
				{ name: 'collision(uint256)', hasVerifiedContract: false },
				{ name: 'launch(string)', hasVerifiedContract: true },
			] } } }),
		});
		expect(await lookupSignatures(['0xaabbccdd'], { fetchImpl })).toEqual({ '0xaabbccdd': 'launch(string)' });
	});

	it('takes an override without going to the network', async () => {
		const fetchImpl = () => { throw new Error('should not be called'); };
		expect(await lookupSignatures(['0x12345678'], { fetchImpl, overrides: { '0x12345678': 'mine()' } }))
			.toEqual({ '0x12345678': 'mine()' });
	});

	it('reports a selector nothing can name', async () => {
		const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { function: {} } }) });
		expect(await lookupSignatures(['0x99999999'], { fetchImpl })).toEqual({ '0x99999999': null });
	});
});

describe('curated overrides', () => {
	it('every override states a reason', () => {
		for (const [address, override] of Object.entries(VENUE_OVERRIDES)) {
			expect(address, 'override keys are lowercase addresses').toMatch(/^0x[0-9a-f]{40}$/);
			expect(override.reason.length, `${address} needs a reason`).toBeGreaterThan(30);
		}
	});

	it('adds a binding the anchor could not reveal', () => {
		const descriptor = { ...anchor, address: '0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007' };
		const enriched = applyOverride(descriptor, () => true);
		expect(enriched.kind).toBe('bonding-curve');
		expect(enriched.quote.symbol).toBe('VIRTUAL');
		expect(enriched.launch.bindings.some((b) => b.role === 'buyAmount')).toBe(true);
	});

	it('drops a binding that points outside the argument tree', () => {
		const descriptor = { ...anchor, address: '0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007' };
		const enriched = applyOverride(descriptor, () => false);
		expect(enriched.launch.bindings.some((b) => b.role === 'buyAmount')).toBe(false);
		expect(enriched.overrideDropped).toBe(1);
	});

	it('leaves a venue with no override alone', () => {
		expect(applyOverride(anchor, () => true)).toBe(anchor);
	});
});

describe('telling a launch apart from everything else that mints a token', () => {
	it('accepts the verbs a launchpad uses', () => {
		for (const name of ['launchToken(uint256)', 'createLaunch()', 'deployToken()', 'newTokenV6()', 'deployCoin()', 'preLaunch()', 'launchPairRewards()']) {
			expect(classifyLaunchFunction(name).launch, name).toBe(true);
		}
	});

	it('refuses a bridge, a router, and a smart account', () => {
		for (const name of ['finalizeInboundTransfer(address,address,address,uint256,bytes)', 'swap(bytes)', 'deposit()', 'execute(bytes)', 'multicall(bytes[])', 'handleOps((address,uint256)[],address)']) {
			const verdict = classifyLaunchFunction(name);
			expect(verdict.launch, name).toBe(false);
			expect(verdict.reason).toContain(name.slice(0, name.indexOf('(')));
		}
	});

	it('says why, so the catalog can print it', () => {
		expect(classifyLaunchFunction('rebalance()').reason).toMatch(/does not read as a launch entry point/);
	});
});

describe('proving a venue accepts what the descriptor wants to change', () => {
	// The failure this guards against is real and was found on chain: a venue's
	// launch call carries two bytes32 arguments, inference called the first one
	// a salt because it was non-zero, and it is actually a commitment to a
	// launch configuration. Randomising it reverts with LaunchEconomicsMismatch.
	// Nothing in the ABI says which is which. One eth_call each does.
	const base = {
		...anchor,
		launch: {
			...anchor.launch,
			bindings: [
				{ role: 'name', path: [0, 0], type: 'string' },
				{ role: 'symbol', path: [0, 1], type: 'string' },
				{ role: 'metadataUri', path: [0, 2], type: 'string' },
				{ role: 'salt', path: [3], type: 'bytes32' },
			],
		},
	};

	const clientThat = (predicate) => ({
		calls: [],
		async call(args) {
			this.calls.push(args);
			if (predicate(args)) return { data: '0x' };
			throw Object.assign(new Error('execution reverted'), { shortMessage: 'execution reverted', cause: { signature: '0xecb27319' } });
		},
	});

	it('keeps every binding a venue accepts', async () => {
		const client = clientThat(() => true);
		const probed = await probeDescriptor({ client, descriptor: base });
		expect(probed.usable).toBe(true);
		expect(probed.probe.accepted.sort()).toEqual(['metadataUri', 'name', 'salt', 'symbol']);
		expect(probed.probe.rejected).toBeUndefined();
	});

	it('prunes a bytes32 the venue will not let you change, and says why', async () => {
		// Reverts whenever the salt leaf differs from the anchor's.
		const anchorSalt = base.launch.template[3].toLowerCase().slice(2);
		const client = clientThat((args) => args.data.toLowerCase().includes(anchorSalt));
		const probed = await probeDescriptor({ client, descriptor: base });
		expect(probed.usable).toBe(true);
		expect(probed.probe.accepted).not.toContain('salt');
		expect(probed.probe.rejected).toHaveLength(1);
		expect(probed.probe.rejected[0]).toMatchObject({ role: 'salt', revert: '0xecb27319' });
		expect(probed.probe.rejected[0].note).toMatch(/replayed rather than randomised/);
		expect(probed.launch.bindings.some((b) => b.role === 'salt')).toBe(false);
	});

	it('refuses a venue that will not accept a different name at all', async () => {
		const client = clientThat(() => false);
		const probed = await probeDescriptor({ client, descriptor: base });
		expect(probed.usable).toBe(false);
		expect(probed.reason).toMatch(/only the name, symbol and deadline changed/);
		expect(probed.reason).toContain('0xecb27319');
		expect(probed.probe).toMatchObject({ ok: false, revert: '0xecb27319' });
	});

	it('funds the probe inside the simulation and never outside it', async () => {
		const client = clientThat(() => true);
		await probeDescriptor({ client, descriptor: base });
		// Calls that measure a token's storage layout carry no account; the
		// ones that actually simulate the launch are the ones under test.
		const launches = client.calls.filter((call) => String(call.to).toLowerCase() === base.address.toLowerCase());
		expect(launches.length).toBeGreaterThan(0);
		for (const call of launches) {
			expect(call.account).toBe(PROBE_ACCOUNT);
			expect(call.stateOverride[0]).toEqual({ address: PROBE_ACCOUNT, balance: 10n ** 20n });
		}
	});

	it('never sends a transaction, only reads', async () => {
		const client = clientThat(() => true);
		client.sendTransaction = () => { throw new Error('a probe must never send'); };
		client.writeContract = () => { throw new Error('a probe must never write'); };
		await expect(probeDescriptor({ client, descriptor: base })).resolves.toBeDefined();
	});

	it('never probes under the anchor token\'s identity', async () => {
		const client = clientThat(() => true);
		await probeDescriptor({ client, descriptor: base });
		const hex = Buffer.from(anchor.evidence.symbol, 'utf8').toString('hex');
		for (const call of client.calls) expect(call.data.toLowerCase()).not.toContain(hex);
	});

	it('leaves an already-refused venue alone', async () => {
		const client = { call: async () => { throw new Error('should not be called'); } };
		const refused = { ...base, usable: false, reason: 'no signature' };
		expect(await probeDescriptor({ client, descriptor: refused })).toBe(refused);
	});
});

describe('the one-shot liveness check', () => {
	const descriptor = { ...anchor };

	it('reports a venue that would launch', async () => {
		const client = { simulateContract: async () => ({ result: '0x0' }) };
		const result = await simulateLaunch({ client, descriptor });
		expect(result.ok).toBe(true);
		expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('funds the probe with a state override rather than real money', async () => {
		let seen = null;
		const client = { simulateContract: async (args) => { seen = args; return { result: null }; } };
		await simulateLaunch({ client, descriptor, probe: '0x000000000000000000000000000000000000dEaD' });
		expect(seen.stateOverride[0].balance).toBe(100n * 10n ** 18n);
		expect(seen.account).toBe('0x000000000000000000000000000000000000dEaD');
	});

	it('launches under a fresh identity, never the anchor token\'s', async () => {
		let seen = null;
		const client = { simulateContract: async (args) => { seen = args; return { result: null }; } };
		await simulateLaunch({ client, descriptor });
		const encoded = JSON.stringify(seen.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
		expect(encoded).toContain('PROBE');
		expect(encoded).not.toContain(anchor.evidence.symbol);
	});

	it('records the revert instead of throwing', async () => {
		const err = Object.assign(new Error('reverted'), { shortMessage: 'reverted', cause: { signature: '0xf2cef899' } });
		const client = { simulateContract: async () => { throw err; } };
		const result = await simulateLaunch({ client, descriptor });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('0xf2cef899');
	});

	it('does not simulate a venue that was already refused', async () => {
		const client = { simulateContract: async () => { throw new Error('should not be called'); } };
		const result = await simulateLaunch({ client, descriptor: { ...descriptor, usable: false, reason: 'no signature' } });
		expect(result).toMatchObject({ ok: false, reason: 'no signature' });
	});
});

describe('salt candidates', () => {
	// A call can carry several bytes32 arguments. Proposing only the first is
	// how a real CREATE2 salt ends up replayed, which either reverts on an
	// address collision or, worse, mints at an address somebody else mined.
	const types = ['(string,string,bytes32,bytes32)'];
	const facts = { name: 'Loop Rat', symbol: 'LOOPRAT' };
	const args = [['Loop Rat', 'LOOPRAT', `0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`]];

	it('proposes every non-zero bytes32, not just the first', () => {
		const salts = inferBindings({ args, types, facts }).filter((b) => b.role === 'salt');
		expect(salts.map((b) => b.path)).toEqual([[0, 2], [0, 3]]);
	});

	it('leaves a zero bytes32 alone, because it is not a salt', () => {
		const zeroed = [['Loop Rat', 'LOOPRAT', `0x${'0'.repeat(64)}`, `0x${'b'.repeat(64)}`]];
		const salts = inferBindings({ args: zeroed, types, facts }).filter((b) => b.role === 'salt');
		expect(salts.map((b) => b.path)).toEqual([[0, 3]]);
	});

	it('keeps only the candidates the venue accepts', async () => {
		const descriptor = {
			...anchor,
			launch: {
				...anchor.launch,
				signature: 'launch(string,string,bytes32,bytes32)',
				template: ['Loop Rat', 'LOOPRAT', `0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`],
				bindings: [
					{ role: 'name', path: [0], type: 'string' },
					{ role: 'symbol', path: [1], type: 'string' },
					{ role: 'salt', path: [2], type: 'bytes32' },
					{ role: 'salt', path: [3], type: 'bytes32' },
				],
			},
		};
		// The venue insists on keeping argument 2 exactly as the anchor had it.
		const client = {
			async call(args_) {
				if (args_.data.toLowerCase().includes('a'.repeat(64))) return { data: '0x' };
				throw Object.assign(new Error('reverted'), { shortMessage: 'reverted', cause: { signature: '0xecb27319' } });
			},
		};
		const probed = await probeDescriptor({ client, descriptor });
		expect(probed.usable).toBe(true);
		const salts = probed.launch.bindings.filter((b) => b.role === 'salt');
		expect(salts.map((b) => b.path)).toEqual([[3]]);
		expect(probed.probe.rejected.map((r) => r.path)).toEqual([[2]]);
	});
});

describe('deadlines', () => {
	const types = argumentTypes('launch(string,string,uint256,uint256)');
	const anchorTime = 1_780_000_000;
	const facts = { name: 'Loop Rat', symbol: 'LOOPRAT', timestamp: anchorTime };

	it('recognises a unix timestamp near the anchor block', () => {
		const bindings = inferBindings({ args: ['Loop Rat', 'LOOPRAT', 1_000_000n, BigInt(anchorTime + 600)], types, facts });
		expect(bindings.find((b) => b.role === 'deadline')?.path).toEqual([3]);
	});

	it('leaves an ordinary amount alone', () => {
		const bindings = inferBindings({ args: ['Loop Rat', 'LOOPRAT', 1_000_000n, 5n], types, facts });
		expect(bindings.some((b) => b.role === 'deadline')).toBe(false);
	});

	it('does not mistake a far-future number for a deadline', () => {
		const bindings = inferBindings({ args: ['Loop Rat', 'LOOPRAT', 1_000_000n, BigInt(anchorTime + 10 * 365 * 86_400)], types, facts });
		expect(bindings.some((b) => b.role === 'deadline')).toBe(false);
	});

	it('finds nothing without the anchor block time to compare against', () => {
		const bindings = inferBindings({ args: ['Loop Rat', 'LOOPRAT', 1_000_000n, BigInt(anchorTime + 600)], types, facts: { ...facts, timestamp: null } });
		expect(bindings.some((b) => b.role === 'deadline')).toBe(false);
	});

	it('is a role the toolkit always regenerates', () => {
		expect(REGENERATED_ROLES).toContain('deadline');
		expect(REGENERATED_ROLES).toContain('salt');
		expect(CALLER_ROLES).not.toContain('deadline');
	});
});

describe('a token whose name and symbol are the same string', () => {
	// Memecoins do this constantly, and the naive "break on first match" loop
	// binds the name, fails to bind the symbol because that leaf is already
	// taken, and breaks anyway. The venue then looks like one that hides its
	// token identity and is dropped. This is the regression test for the
	// busiest launchpad on Robinhood Chain going missing from the catalog.
	const types = ['(string,string,string)'];
	const args = [['BILLY', 'BILLY', 'https://example.com/billy.png']];

	it('binds both, on separate leaves', () => {
		const bindings = inferBindings({ args, types, facts: { name: 'BILLY', symbol: 'BILLY' } });
		const byRole = Object.fromEntries(bindings.map((b) => [b.role, b.path.join('.')]));
		expect(byRole.name).toBe('0.0');
		expect(byRole.symbol).toBe('0.1');
	});

	it('still binds both when the calldata orders them symbol first', () => {
		const bindings = inferBindings({ args: [['TICK', 'Tick Token', '']], types, facts: { name: 'Tick Token', symbol: 'TICK' } });
		const byRole = Object.fromEntries(bindings.map((b) => [b.role, b.path.join('.')]));
		expect(byRole.name).toBe('0.1');
		expect(byRole.symbol).toBe('0.0');
	});

	it('binds the symbol even when only one leaf carries it', () => {
		const bindings = inferBindings({ args: [['BILLY', '', '']], types, facts: { name: 'BILLY', symbol: 'BILLY' } });
		const roles = bindings.map((b) => b.role);
		expect(roles).toContain('name');
		expect(roles).not.toContain('symbol');
	});
});

describe('measuring where an ERC-20 keeps its balances', () => {
	// Solidity puts `mapping(address => uint256)` at slot s under
	// keccak256(holder . s). Nothing exposes s, so it is measured: write a
	// sentinel to each candidate and ask the token what it thinks the balance
	// is. The slot that answers with the sentinel is the one.
	const SENTINEL = 0x5eed12345eed1234n;
	const holder = '0x1111111111111111111111111111111111111111';
	const spender = '0x2222222222222222222222222222222222222222';
	const token = '0x3333333333333333333333333333333333333333';

	/** A token whose balances live at `balanceAt` and allowances at `allowanceAt`. */
	const tokenAt = (balanceAt, allowanceAt) => ({
		async call({ data, stateOverride }) {
			const selector = data.slice(0, 10);
			if (selector === '0x313ce567') return { data: `0x${(18).toString(16).padStart(64, '0')}` }; // decimals
			const written = stateOverride?.[0]?.stateDiff?.[0];
			if (!written) return { data: `0x${'0'.repeat(64)}` };
			const wanted = selector === '0x70a08231' // balanceOf
				? mappingSlot(holder, balanceAt)
				: nestedMappingSlot(holder, spender, allowanceAt);
			return { data: written.slot === wanted ? written.value : `0x${'0'.repeat(64)}` };
		},
	});

	it('finds a layout it has never seen before', async () => {
		clearSlotCache();
		const found = await findErc20Slots({ client: tokenAt(7, 11), token, holder, spender });
		expect(found).toEqual({ balanceSlot: 7, allowanceSlot: 11 });
	});

	it('reports unknown rather than guessing when nothing matches', async () => {
		clearSlotCache();
		const client = { call: async () => ({ data: `0x${'0'.repeat(64)}` }) };
		expect(await findErc20Slots({ client, token, holder, spender, maxSlot: 4 })).toEqual({ balanceSlot: null, allowanceSlot: null });
	});

	it('turns a measured layout into overrides that fund one call', async () => {
		clearSlotCache();
		const overrides = await fundOverride({ client: tokenAt(1, 3), token, holder, spender, amount: 500n });
		expect(overrides).toHaveLength(1);
		expect(overrides[0].address).toBe(token);
		expect(overrides[0].stateDiff.map((d) => d.slot)).toEqual([mappingSlot(holder, 1), nestedMappingSlot(holder, spender, 3)]);
		for (const diff of overrides[0].stateDiff) expect(BigInt(diff.value)).toBe(500n);
	});

	it('funds nothing when the layout could not be measured', async () => {
		clearSlotCache();
		const client = { call: async () => ({ data: `0x${'0'.repeat(64)}` }) };
		expect(await fundOverride({ client, token, holder, spender })).toEqual([]);
	});

	it('derives the same slot Solidity would', () => {
		// keccak256(abi.encode(holder, 0)) is the canonical first-slot mapping key.
		expect(mappingSlot(holder, 0)).toMatch(/^0x[0-9a-f]{64}$/);
		expect(mappingSlot(holder, 0)).not.toBe(mappingSlot(holder, 1));
		expect(nestedMappingSlot(holder, spender, 0)).not.toBe(mappingSlot(holder, 0));
	});

	it('does not treat a non-token as a token', async () => {
		const client = { call: async () => { throw new Error('no such function'); } };
		expect(await isErc20(client, token)).toBe(false);
	});

	it('recognises a token by its decimals', async () => {
		expect(await isErc20(tokenAt(1, 2), token)).toBe(true);
	});
});
