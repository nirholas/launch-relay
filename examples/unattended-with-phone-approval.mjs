// An unattended relay that still cannot spend without you.
//
// The process runs headless on a server. When a coin clears the rules, the
// launch plan arrives in Telegram with the wallet, the pools, and the exact
// cost, and nothing is signed until someone taps Approve. The private key never
// leaves the machine, and an unreachable approver denies rather than proceeds.
//
//   LAUNCH_RELAY_ARMED=1 \
//   LAUNCH_RELAY_MNEMONIC="..." \
//   LAUNCH_RELAY_TELEGRAM_TOKEN=... \
//   LAUNCH_RELAY_TELEGRAM_CHAT_ID=... \
//   LAUNCH_RELAY_TELEGRAM_USER_IDS=... \
//   node examples/unattended-with-phone-approval.mjs

import { createTelegramClient, createTelegramApproval, createNotifier, presets } from 'launch-relay';

if (process.env.LAUNCH_RELAY_ARMED !== '1') {
	throw new Error('set LAUNCH_RELAY_ARMED=1 to let this spend, after a dry run you have read');
}

const telegram = createTelegramClient({
	token: process.env.LAUNCH_RELAY_TELEGRAM_TOKEN,
	chatId: process.env.LAUNCH_RELAY_TELEGRAM_CHAT_ID,
	// Without this, anyone who ends up in the chat can approve a launch. In a
	// group chat, treat it as required.
	allowedUserIds: (process.env.LAUNCH_RELAY_TELEGRAM_USER_IDS || '').split(',').filter(Boolean),
});

// Fail fast on a bad token or the wrong chat id, rather than discovering it at
// the moment the first launch needs approving.
const me = await telegram.check();
console.log(`telegram connected as @${me.username}`);

const notify = createNotifier([telegram]);

const { relay } = await presets.pumpfunToPairfund({
	mnemonic: process.env.LAUNCH_RELAY_MNEMONIC,
	wallets: 3,
	mode: 'live',

	// Every launch waits for a tap. Five minutes, then it is rejected.
	confirm: createTelegramApproval({ client: telegram, timeoutMs: 300_000 }),

	rules: {
		minMarketCapUsd: 50_000,
		maxSignalAgeSeconds: 300,
		requireImage: true,
		maxCreatorLaunches: 5,
		denyWords: ['rug', 'scam'],
	},
	markets: { strategy: 'thematic', count: 2 },

	// The second brake. Even with standing approval this could not run away.
	budget: {
		maxLaunchesPerHour: 2,
		maxLaunchesPerDay: 8,
		maxSpendPerLaunch: '0.005',
		maxSpendPerDay: '0.03',
		minWalletReserve: '0.002',
		killSwitchFile: './HALT',
	},

	onLaunch: (event) => notify.launched(event),
});

relay.start();
console.log('relay running. approvals will arrive in Telegram.');

const shutdown = () => {
	relay.stop();
	telegram.stop();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
