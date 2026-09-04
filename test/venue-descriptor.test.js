import { describe, expect, it } from 'vitest';
import anchor from './fixtures/venue-anchor.json' with { type: 'json' };
import {
	argumentTypes, buildArgs, dehydrate, describeBindings, encodeLaunchCall, hydrate, readPath,
	tupleComponents, verifyDescriptor, writePath,
} from '../src/chains/robinhood/venues/descriptor.js';

describe('ABI type parsing', () => {
	it('splits a flat argument list', () => {
		expect(argumentTypes('launch(string,uint256)')).toEqual(['string', 'uint256']);
	});

	it('keeps nested tuples intact', () => {
		expect(tupleComponents('(string,(uint8,address),bytes32[])')).toEqual(['string', '(uint8,address)', 'bytes32[]']);
	});

	it('reads the real venue signature', () => {
		expect(argumentTypes(anchor.launch.signature)).toEqual([
			'(string,string,string,string,(string,string,string,string,string),address)',
			'uint256',
			'uint256',
			'bytes32',
		]);
	});
});

describe('hydrate and dehydrate', () => {
	it('restores integers a JSON round trip flattened to strings', () => {
		expect(hydrate('uint256', '42')).toBe(42n);
		expect(hydrate('(uint8,address)', ['3', '0xabc'])).toEqual([3n, '0xabc']);
		expect(hydrate('uint256[]', ['1', '2'])).toEqual([1n, 2n]);
	});

	it('is the inverse of dehydrate', () => {
		const types = argumentTypes(anchor.launch.signature);
		const args = types.map((type, i) => hydrate(type, anchor.launch.template[i]));
		expect(dehydrate(args)).toEqual(anchor.launch.template);
	});
});

describe('paths', () => {
	it('reads a nested leaf', () => {
		expect(readPath([['a', ['b', 'c']]], [0, 1, 0])).toBe('b');
	});

	it('writes without mutating the original', () => {
		const tree = [['a', 'b']];
		const next = writePath(tree, [0, 1], 'z');
		expect(next[0][1]).toBe('z');
		expect(tree[0][1]).toBe('b');
	});
});

describe('the anchor descriptor', () => {
	it('reproduces the transaction it was learned from, byte for byte', () => {
		expect(verifyDescriptor(anchor)).toEqual({ ok: true });
		expect(encodeLaunchCall(anchor).data.toLowerCase()).toBe(anchor.evidence.input.toLowerCase());
	});

	it('bound the fields whose meaning is visible in the anchor', () => {
		const roles = anchor.launch.bindings.map((b) => b.role).sort();
		expect(roles).toEqual(['creator', 'metadataUri', 'name', 'salt', 'symbol', 'twitter']);
	});

	it('substitutes only what it was given', () => {
		const args = buildArgs(anchor, { name: 'Loop Rat', symbol: 'LOOPRAT' });
		expect(readPath(args, [0, 0])).toBe('Loop Rat');
		expect(readPath(args, [0, 1])).toBe('LOOPRAT');
		// The description was not bound and not supplied, so it is replayed.
		expect(readPath(args, [0, 3])).toBe(readPath(anchor.launch.template, [0, 3]));
	});

	it('leaves a bound field alone when the caller passes nothing', () => {
		const args = buildArgs(anchor, {});
		expect(readPath(args, [0, 0])).toBe(anchor.evidence.name);
	});

	it('changes the calldata as soon as a value differs', () => {
		const changed = encodeLaunchCall(anchor, { symbol: 'OTHER' }).data;
		expect(changed).not.toBe(anchor.evidence.input);
	});

	it('describes what it will fill in', () => {
		const lines = describeBindings(anchor);
		expect(lines.some((l) => l.startsWith('name'))).toBe(true);
		expect(lines.at(-1)).toContain(anchor.evidence.txHash);
	});
});

describe('verification refuses a descriptor that cannot prove itself', () => {
	it('rejects an edited template', () => {
		const tampered = structuredClone(anchor);
		tampered.launch.template[0][0] = 'Not What Launched';
		expect(verifyDescriptor(tampered).ok).toBe(false);
	});

	it('rejects a signature that is not the one that was called', () => {
		const tampered = structuredClone(anchor);
		tampered.launch.signature = 'launchToken(string,uint256)';
		expect(verifyDescriptor(tampered).ok).toBe(false);
	});

	it('rejects a binding that points outside the template', () => {
		const tampered = structuredClone(anchor);
		tampered.launch.bindings.push({ role: 'website', path: [9, 9], type: 'string' });
		expect(verifyDescriptor(tampered).ok).toBe(false);
	});

	it('rejects a role it does not know', () => {
		const tampered = structuredClone(anchor);
		tampered.launch.bindings.push({ role: 'whatever', path: [1], type: 'uint256' });
		expect(verifyDescriptor(tampered).ok).toBe(false);
	});

	it('rejects a descriptor with no anchor at all', () => {
		const tampered = structuredClone(anchor);
		delete tampered.evidence.input;
		expect(verifyDescriptor(tampered).ok).toBe(false);
	});
});
