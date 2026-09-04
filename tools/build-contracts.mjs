#!/usr/bin/env node
// Compile contracts/*.sol into src/chains/robinhood/artifacts/.
//
// The artifacts are committed so that installing the package does not pull a
// Solidity compiler, and so the bytecode a launch deploys is reviewable in the
// same diff as the source it came from. Re-run this after touching a contract:
//
//   npm run build:contracts
//
// The output is deterministic for a given compiler version and settings, so a
// reviewer can reproduce the committed artifact byte for byte.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(root, 'src/chains/robinhood/artifacts');

const SOURCES = [
	{ file: 'LaunchToken.sol', contract: 'LaunchToken', out: 'launch-token.json' },
	{ file: 'LiquidityLocker.sol', contract: 'LiquidityLocker', out: 'liquidity-locker.json' },
	{ file: 'LaunchRegistry.sol', contract: 'LaunchRegistry', out: 'launch-registry.json' },
	{ file: 'RelayLauncher.sol', contract: 'RelayLauncher', out: 'relay-launcher.json' },
	{ file: 'adapters/UniswapV2Adapter.sol', contract: 'UniswapV2Adapter', out: 'uniswap-v2-adapter.json' },
	{ file: 'adapters/UniswapV3Adapter.sol', contract: 'UniswapV3Adapter', out: 'uniswap-v3-adapter.json' },
];

const SETTINGS = {
	optimizer: { enabled: true, runs: 1_000_000 },
	evmVersion: 'cancun',
	outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'metadata'] } },
};

const solc = require('solc');

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	for (const { file, contract, out } of SOURCES) {
		const source = await readFile(join(root, 'contracts', file), 'utf8');
		// Contracts import each other by relative path, so the compiler needs a
		// resolver. Everything is read from contracts/ and nowhere else: this
		// build has no node_modules dependency and no remappings to get wrong.
		const dir = dirname(join(root, 'contracts', file));
		const resolve = (path) => {
			try {
				return { contents: readFileSync(path.startsWith('.') ? join(dir, path) : join(root, 'contracts', path), 'utf8') };
			} catch (err) {
				return { error: `cannot find ${path}: ${err.message}` };
			}
		};
		const input = { language: 'Solidity', sources: { [file]: { content: source } }, settings: SETTINGS };
		const result = JSON.parse(solc.compile(JSON.stringify(input), { import: resolve }));
		const fatal = (result.errors || []).filter((e) => e.severity === 'error');
		if (fatal.length) {
			for (const e of fatal) console.error(e.formattedMessage);
			process.exit(1);
		}
		for (const e of result.errors || []) console.warn(e.formattedMessage.trim());

		const artifact = result.contracts?.[file]?.[contract];
		if (!artifact) throw new Error(`compiler produced no output for ${contract} in ${file}`);
		const bytecode = `0x${artifact.evm.bytecode.object}`;
		if (bytecode.length <= 2) throw new Error(`${contract} compiled to empty bytecode`);

		const payload = {
			contract,
			source: `contracts/${file}`,
			compiler: solc.version(),
			settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion },
			abi: artifact.abi,
			bytecode,
		};
		await writeFile(join(OUT_DIR, out), `${JSON.stringify(payload, null, '\t')}\n`);
		console.log(`${contract} -> src/chains/robinhood/artifacts/${out} (${(bytecode.length - 2) / 2} bytes, solc ${solc.version()})`);
	}
}

await main();
