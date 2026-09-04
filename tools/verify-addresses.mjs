#!/usr/bin/env node
// Re-derive every address in src/chains/robinhood/contracts.js from live chain
// state and fail if one has drifted.
//
//   npm run rhc:verify
//
// An address book is the most dangerous file in a bot that spends money: it is
// the one place where a wrong constant sends a real transfer to a contract
// that answers today instead of the one that answered when the constant was
// written. Nothing here is trusted because it is written down; each entry has
// a check that proves it against the chain, and a mismatch exits non-zero.

import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { AMMS, DECIMALS, INFRA, TOKENS } from '../src/chains/robinhood/contracts.js';
import { ROBINHOOD_RPC_URL, robinhoodChain } from '../src/chains/robinhood/chain.js';

const rpcUrl = process.env.LAUNCH_RELAY_RPC_URL || ROBINHOOD_RPC_URL;
// The public endpoint rate-limits, and a check that reports a good address as
// bad because the network hiccuped is worse than no check at all.
const client = createPublicClient({
	chain: robinhoodChain({ rpcUrl }),
	transport: http(rpcUrl, { retryCount: 8, retryDelay: 1_500, timeout: 30_000 }),
});

const abi = parseAbi([
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function factory() view returns (address)',
	'function WETH() view returns (address)',
	'function WETH9() view returns (address)',
	'function name() view returns (string)',
	'function poolManager() view returns (address)',
	'function permit2() view returns (address)',
	'function allPairsLength() view returns (uint256)',
	'function feeAmountTickSpacing(uint24) view returns (int24)',
]);

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
let failures = 0;

function report(label, ok, detail) {
	if (!ok) failures++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

async function read(address, functionName, args) {
	return retry(() => client.readContract({ address: getAddress(address), abi, functionName, args }));
}

/**
 * Retry the reads that the public endpoint throttles.
 *
 * viem's transport already retries a failed request, but a Cloudflare
 * challenge comes back as a 200 with HTML in the body, which surfaces as a
 * decode error rather than a retryable one and sails straight through. This
 * script exists to be believed: reporting that a pinned address has changed
 * when the only thing that changed was the rate limit is worse than not
 * checking at all.
 */
async function retry(fn, attempts = 5) {
	let last;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			last = err;
			const message = String(err?.details || err?.shortMessage || err?.message || '');
			if (!/HTTP request failed|Just a moment|rate limit|429|too many/i.test(message)) throw err;
			await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
		}
	}
	throw last;
}

async function checkToken(key, address) {
	try {
		const [symbol, decimals] = await Promise.all([read(address, 'symbol'), read(address, 'decimals')]);
		const expected = DECIMALS[address.toLowerCase()];
		const ok = symbol === key && (expected === undefined || Number(decimals) === expected);
		report(`TOKENS.${key}`, ok, `symbol=${symbol} decimals=${decimals}`);
	} catch (err) {
		report(`TOKENS.${key}`, false, short(err));
	}
}

async function checkCode(label, address) {
	try {
		const code = await retry(() => client.getCode({ address: getAddress(address) }));
		report(label, Boolean(code && code.length > 2), `${code ? (code.length - 2) / 2 : 0} bytes`);
	} catch (err) {
		report(label, false, short(err));
	}
}

async function checkV2(amm) {
	try {
		const [pairs, factory, weth] = await Promise.all([
			read(amm.factory, 'allPairsLength'),
			read(amm.router, 'factory'),
			read(amm.router, 'WETH'),
		]);
		report('AMMS.uniswap-v2.factory', pairs > 0n, `${pairs} pairs`);
		report('AMMS.uniswap-v2.router', same(factory, amm.factory) && same(weth, TOKENS.WETH), `factory=${factory}`);
	} catch (err) {
		report('AMMS.uniswap-v2', false, short(err));
	}
}

async function checkV3(amm) {
	try {
		const [factory, weth9, name] = await Promise.all([
			read(amm.positionManager, 'factory'),
			read(amm.positionManager, 'WETH9'),
			read(amm.positionManager, 'name'),
		]);
		report('AMMS.uniswap-v3.positionManager', same(factory, amm.factory) && same(weth9, TOKENS.WETH), name);
		for (const [fee, spacing] of Object.entries(amm.feeTiers)) {
			const live = await read(amm.factory, 'feeAmountTickSpacing', [Number(fee)]);
			report(`AMMS.uniswap-v3.feeTiers[${fee}]`, Number(live) === spacing, `tickSpacing=${live}`);
		}
	} catch (err) {
		report('AMMS.uniswap-v3', false, short(err));
	}
}

async function checkV4(amm) {
	try {
		const [manager, permit2, name] = await Promise.all([
			read(amm.positionManager, 'poolManager'),
			read(amm.positionManager, 'permit2'),
			read(amm.positionManager, 'name'),
		]);
		report('AMMS.uniswap-v4.positionManager', same(manager, amm.poolManager) && same(permit2, amm.permit2), name);
		await checkCode('AMMS.uniswap-v4.poolManager', amm.poolManager);
	} catch (err) {
		report('AMMS.uniswap-v4', false, short(err));
	}
}

const short = (err) => String(err?.shortMessage || err?.message || err).split('\n')[0].slice(0, 120);

console.log(`verifying the Robinhood Chain address book against ${rpcUrl}\n`);
for (const [key, address] of Object.entries(TOKENS)) await checkToken(key, address);
for (const [key, address] of Object.entries(INFRA)) await checkCode(`INFRA.${key}`, address);
await checkV2(AMMS['uniswap-v2']);
await checkV3(AMMS['uniswap-v3']);
await checkV4(AMMS['uniswap-v4']);

console.log(failures ? `\n${failures} check(s) failed` : '\nevery address checks out');
process.exit(failures ? 1 : 0);
