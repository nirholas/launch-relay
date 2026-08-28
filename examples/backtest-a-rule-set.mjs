// Compare two rule sets against the same slice of history.
//
// The interesting question is never "is my filter good", it is "is this filter
// better than that one, on the same data". Pull the history once and replay both
// through it.
//
//   node examples/backtest-a-rule-set.mjs

import { backtest, createMarketSelector, fetchGraduationHistory, renderBacktest } from 'launch-relay';

const signals = await fetchGraduationHistory({
	limit: 300,
	onProgress: (msg) => process.stderr.write(`${msg}\n`),
});

const budget = { maxLaunchesPerHour: 3, maxLaunchesPerDay: 12, cooldownMs: 60_000 };
const marketSelector = createMarketSelector({ strategy: 'thematic', count: 2 });

const candidates = {
	'artwork only': { requireImage: true },
	'artwork and socials': { requireImage: true, requireSocials: 'any' },
	'artwork, socials, no obvious junk': {
		requireImage: true,
		requireSocials: 'twitter',
		denyWords: ['rug', 'scam', 'test', 'presale'],
	},
};

for (const [label, rules] of Object.entries(candidates)) {
	const report = await backtest({ signals, rules, budget, marketSelector, markets: [] });
	console.log(`\n${'='.repeat(70)}\n${label}\n${'='.repeat(70)}`);
	console.log(renderBacktest(report));
}

// A filter that selects fewer coins is not automatically better. Read the
// sample sizes: a rule set that passes four coins out of three hundred can
// post any median lift you like and mean nothing by it.
