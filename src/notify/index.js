// Notification fan-out.
//
// One `notify` object, any number of transports. The relay emits four things
// worth knowing about from a distance: a launch landed, a launch failed, the
// budget stopped something, and the relay itself came up or went down. Skips
// are deliberately not broadcast: a relay skips hundreds of coins an hour and a
// channel that fires on every one of them is a channel you mute.

import { createTelegramClient } from './telegram.js';
import { createWebhookTransport } from './webhook.js';

/**
 * @param {Array<{send: (text: string, event: object) => Promise<any>}>} transports
 * @param {{logger?: import('../types.js').Logger}} [opts]
 */
export function createNotifier(transports = [], opts = {}) {
	const log = opts.logger;
	const fanOut = async (text, event) => {
		await Promise.all(transports.map(async (t) => {
			try {
				await t.send(text, event);
			} catch (err) {
				log?.warn?.(`notification failed: ${err.message}`);
			}
		}));
	};

	return {
		transports,
		enabled: transports.length > 0,

		launched({ spec, plan, result }) {
			return fanOut(
				[
					`LAUNCHED ${spec.symbol} on ${plan.target}`,
					`${spec.name}`,
					`cost ${plan.cost.totalNative} ${plan.cost.nativeSymbol} from ${plan.wallet}`,
					plan.markets?.markets?.length ? `pools ${plan.markets.markets.map((m) => m.symbol).join(', ')}` : '',
					result.url || '',
				].filter(Boolean).join('\n'),
				{ type: 'launched', symbol: spec.symbol, url: result.url, txHash: result.txHash },
			);
		},

		failed({ spec, result }) {
			return fanOut(
				`LAUNCH FAILED ${spec?.symbol || '?'}: ${result?.error || 'unknown error'}`,
				{ type: 'failed', symbol: spec?.symbol, error: result?.error },
			);
		},

		halted({ reason }) {
			return fanOut(`RELAY HALTED: ${reason}`, { type: 'halted', reason });
		},

		status(text) {
			return fanOut(text, { type: 'status' });
		},
	};
}

/**
 * Build transports from config plus environment. Secrets stay in the
 * environment; the config only names which channels are on.
 *
 * @param {object} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildTransports(config = {}, env = process.env) {
	const transports = [];

	const token = env[config.telegram?.tokenEnv || 'LAUNCH_RELAY_TELEGRAM_TOKEN'];
	const chatId = env[config.telegram?.chatIdEnv || 'LAUNCH_RELAY_TELEGRAM_CHAT_ID'];
	if (config.telegram?.enabled !== false && token && chatId) {
		transports.push(createTelegramClient({
			token,
			chatId,
			allowedUserIds: config.telegram?.allowedUserIds || splitList(env.LAUNCH_RELAY_TELEGRAM_USER_IDS),
		}));
	}

	const webhookUrl = config.webhook?.url || env.LAUNCH_RELAY_WEBHOOK_URL;
	if (webhookUrl) {
		transports.push(createWebhookTransport({ url: webhookUrl, format: config.webhook?.format }));
	}

	return transports;
}

const splitList = (v) => String(v || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

export { createTelegramClient } from './telegram.js';
export { createWebhookTransport } from './webhook.js';
