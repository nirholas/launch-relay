// Who says yes.
//
// The engine will not sign anything in live mode without a `confirm` function
// returning true, and this is where those functions come from. Three of them,
// covering the three ways an operator actually works:
//
//   terminal  a person at a keyboard types yes
//   telegram  a person anywhere taps Approve on their phone
//   standing  the operator pre-authorized everything inside the budget
//
// Every one of them fails closed. No terminal, no answer, no reachable chat:
// all of those deny. The only path to a signature is an affirmative act.

import { createInterface } from 'node:readline/promises';
import { escapeHtml } from './notify/telegram.js';

/**
 * Tap-to-approve from a phone. The relay can run headless on a server while a
 * human keeps the final say, which is the combination that makes an autonomous
 * launcher defensible rather than reckless.
 *
 * @param {object} opts
 * @param {ReturnType<import('./notify/telegram.js').createTelegramClient>} opts.client
 * @param {number} [opts.timeoutMs]    How long a prompt stays live. Default 5 minutes.
 * @param {import('./types.js').Logger} [opts.log]
 * @returns {(plan: import('./types.js').LaunchPlan) => Promise<boolean>}
 */
export function createTelegramApproval({ client, timeoutMs = 300_000, log }) {
	return async (plan) => {
		const body = [
			`<b>LAUNCH APPROVAL</b>`,
			'',
			`<b>${escapeHtml(plan.spec.name)}</b> (${escapeHtml(plan.spec.symbol)})`,
			`<code>${escapeHtml(plan.summary.join('\n'))}</code>`,
			plan.warnings?.length ? `\n<b>warnings</b>\n<code>${escapeHtml(plan.warnings.join('\n'))}</code>` : '',
			'',
			`Approve within ${Math.round(timeoutMs / 60_000)} minutes or this is rejected automatically.`,
		].filter(Boolean).join('\n');

		let decision;
		try {
			decision = await client.ask(body, { timeoutMs });
		} catch (err) {
			// Unreachable approver means no approval. There is no reading of
			// "the chat was down" that means yes.
			log?.warn?.(`telegram approval unavailable, denying: ${err.message}`);
			return false;
		}
		log?.info?.(`telegram approval ${decision.approved ? 'granted' : 'denied'} (${decision.reason})`);
		return decision.approved;
	};
}

/**
 * A person at the terminal.
 *
 * @param {{render: (plan: object) => string}} opts
 */
export function createTerminalApproval({ render }) {
	return async (plan) => {
		if (!process.stdin.isTTY) {
			throw new Error('no terminal available to confirm on; use --yes or a telegram approver');
		}
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			process.stdout.write(`\n${render(plan)}\n`);
			const answer = await rl.question('send this launch? type yes to sign: ');
			return answer.trim().toLowerCase() === 'yes';
		} finally {
			rl.close();
		}
	};
}

/**
 * Standing approval. The operator has already decided that anything inside the
 * budget is acceptable, which makes the budget the real control. It is printed
 * on every launch so an unattended run still leaves a readable trail.
 *
 * @param {{render: (plan: object) => string, log?: import('./types.js').Logger}} opts
 */
export function createStandingApproval({ render, log }) {
	return async (plan) => {
		const text = render(plan);
		if (log?.info) log.info(`\n${text}\napproved by standing authorization (--yes)\n`);
		else process.stdout.write(`\n${text}\napproved by standing authorization (--yes)\n\n`);
		return true;
	};
}

/**
 * Ask several approvers and require all of them. Useful when a Telegram tap
 * should be corroborated by a terminal operator, or for a shared treasury where
 * one person's phone is not enough.
 *
 * @param {Array<(plan: object) => Promise<boolean>>} approvers
 */
export function requireAll(approvers) {
	return async (plan) => {
		for (const approve of approvers) {
			if (!(await approve(plan))) return false;
		}
		return true;
	};
}
