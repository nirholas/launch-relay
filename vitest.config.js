import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.js'],
		environment: 'node',
		// Some suites talk to a live RPC and retry through Cloudflare challenges,
		// and the whole suite runs fine on a loaded machine only if pure-function
		// tests are not racing a 5s default while the CPU is oversubscribed.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
