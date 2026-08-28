// Generic webhook transport.
//
// Posts every relay event as JSON to a URL you control. This is the escape
// hatch: Slack, Discord, a Zapier hook, your own dashboard, a log sink. Failures
// are logged and swallowed, because a notification that cannot be delivered must
// never take down the relay that produced it.

import { fetchJson } from '../http.js';

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {Record<string, string>} [opts.headers]
 * @param {'json'|'discord'|'slack'} [opts.format] Discord and Slack want a `content` / `text` field.
 */
export function createWebhookTransport({ url, headers = {}, format = 'json' }) {
	if (!url) throw new Error('webhook transport needs a url');
	return {
		async send(text, event) {
			const body = format === 'discord'
				? { content: text.slice(0, 1900) }
				: format === 'slack'
					? { text: text.slice(0, 3000) }
					: { text, event };
			try {
				await fetchJson(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...headers },
					body: JSON.stringify(body),
					timeoutMs: 10_000,
				});
			} catch (err) {
				process.stderr.write(`[notify] webhook failed: ${err.message}\n`);
			}
		},
	};
}
