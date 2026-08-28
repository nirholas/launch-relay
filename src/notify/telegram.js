// Telegram transport, with approvals.
//
// This is the piece that makes unattended autonomy actually safe. A relay
// running on a box somewhere proposes a launch, your phone buzzes with the
// wallet, the pools, and the exact cost, and nothing is signed until you tap
// Approve. You get the reaction speed of a bot with the judgment of a person,
// and the key never leaves the machine.
//
// Three properties this depends on, none of them optional:
//
//   Fail closed. A timeout, a dropped connection, a bot that was never started:
//   every one of them denies. An approval system that defaults to yes when it
//   cannot reach you is not an approval system.
//
//   Only you can approve. Callbacks are checked against the configured chat,
//   and optionally against a user allowlist. A bot token is a bearer credential
//   and bots get found.
//
//   One poller. Telegram's getUpdates is a single-consumer queue: two loops on
//   one token steal each other's updates. This owns exactly one loop and
//   dispatches to whoever is waiting.

const API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 25;
const POLL_FLOOR_MS = 250;

/**
 * @param {object} opts
 * @param {string} opts.token        Bot token from BotFather.
 * @param {string|number} opts.chatId
 * @param {(string|number)[]} [opts.allowedUserIds] Users who may approve. Default: anyone in the chat.
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createTelegramClient(opts) {
	const { token, chatId, allowedUserIds = [], fetchImpl = fetch } = opts;
	if (!token) throw new Error('telegram transport needs a bot token');
	if (chatId == null || chatId === '') throw new Error('telegram transport needs a chatId');
	const allowed = new Set(allowedUserIds.map(String));

	/** @type {Map<string, (decision: {approved: boolean, by: string}) => void>} */
	const waiters = new Map();
	let polling = false;
	let offset = 0;
	let stopped = false;

	async function call(method, body, timeoutMs = 20_000) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetchImpl(`${API}/bot${token}/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			const json = await res.json().catch(() => null);
			if (!res.ok || !json?.ok) {
				throw new Error(`telegram ${method} failed: ${json?.description || res.status}`);
			}
			return json.result;
		} finally {
			clearTimeout(timer);
		}
	}

	async function pump() {
		if (polling) return;
		polling = true;
		while (!stopped && waiters.size) {
			let updates;
			try {
				updates = await call(
					'getUpdates',
					{ offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['callback_query'] },
					(POLL_TIMEOUT_S + 10) * 1000,
				);
			} catch {
				// A dropped long poll is routine. Waiters keep their own deadlines,
				// so a reconnect loop cannot turn a network blip into an approval.
				await sleep(2_000);
				continue;
			}
			for (const update of updates || []) {
				offset = Math.max(offset, (update.update_id || 0) + 1);
				handleCallback(update.callback_query);
			}
			// A long poll is supposed to block for POLL_TIMEOUT_S when there is
			// nothing to report, but a proxy, a mocked transport, or an API
			// having a bad day can return instantly. Without a floor that turns
			// this loop into a hot spin that pins a core and eventually dies.
			if (!updates?.length) await sleep(POLL_FLOOR_MS);
		}
		polling = false;
	}

	function handleCallback(query) {
		if (!query) return;
		const data = String(query.data || '');
		const [action, nonce] = data.split(':');
		const waiter = waiters.get(nonce);
		if (!waiter) return;

		const fromChat = String(query.message?.chat?.id ?? '');
		const fromUser = String(query.from?.id ?? '');
		const who = query.from?.username ? `@${query.from.username}` : fromUser;

		if (fromChat !== String(chatId)) return ack(query.id, 'wrong chat');
		if (allowed.size && !allowed.has(fromUser)) return ack(query.id, 'not authorized to approve');

		ack(query.id, action === 'approve' ? 'approved' : 'rejected');
		waiters.delete(nonce);
		waiter({ approved: action === 'approve', by: who });
	}

	const ack = (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});

	return {
		/** Plain message, no interaction. */
		async send(text) {
			return call('sendMessage', {
				chat_id: chatId,
				text: truncate(text),
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			});
		},

		/**
		 * Ask, and wait for a tap.
		 *
		 * @param {string} text
		 * @param {{timeoutMs?: number}} [o]
		 * @returns {Promise<{approved: boolean, by: string, reason: string}>}
		 */
		async ask(text, { timeoutMs = 300_000 } = {}) {
			const nonce = Math.random().toString(36).slice(2, 10);
			const message = await call('sendMessage', {
				chat_id: chatId,
				text: truncate(text),
				parse_mode: 'HTML',
				disable_web_page_preview: true,
				reply_markup: {
					inline_keyboard: [[
						{ text: 'Approve', callback_data: `approve:${nonce}` },
						{ text: 'Reject', callback_data: `reject:${nonce}` },
					]],
				},
			});

			const decision = await new Promise((resolve) => {
				const timer = setTimeout(() => {
					waiters.delete(nonce);
					resolve({ approved: false, by: 'nobody', reason: 'timed out' });
				}, timeoutMs);
				waiters.set(nonce, (d) => {
					clearTimeout(timer);
					resolve({ ...d, reason: d.approved ? 'approved' : 'rejected' });
				});
				pump();
			});

			// Replace the buttons with the outcome so the chat is an audit log
			// rather than a wall of stale prompts nobody can interpret later.
			await call('editMessageText', {
				chat_id: chatId,
				message_id: message.message_id,
				text: truncate(`${text}\n\n<b>${decision.approved ? 'APPROVED' : 'REJECTED'}</b> (${decision.reason}${decision.by !== 'nobody' ? ` by ${escapeHtml(decision.by)}` : ''})`),
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			}).catch(() => {});

			return decision;
		},

		/** Confirm the bot is reachable and the chat id is right. */
		async check() {
			const me = await call('getMe', {});
			await this.send('launch-relay connected. Approvals will arrive here.');
			return { username: me.username, id: me.id };
		},

		stop() {
			stopped = true;
			for (const [nonce, waiter] of waiters) {
				waiters.delete(nonce);
				waiter({ approved: false, by: 'nobody' });
			}
		},
	};
}

// Telegram rejects messages over 4096 characters, and a launch plan with many
// warnings can reach that.
function truncate(text, max = 3900) {
	const s = String(text);
	return s.length <= max ? s : `${s.slice(0, max)}\n...`;
}

export function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
