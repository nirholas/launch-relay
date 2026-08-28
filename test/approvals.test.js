import { describe, expect, it, vi } from 'vitest';
import { createTelegramClient } from '../src/notify/telegram.js';
import { createStandingApproval, createTelegramApproval, requireAll } from '../src/approvals.js';
import { nullLogger } from '../src/log.js';

const ok = (result) => new Response(JSON.stringify({ ok: true, result }), {
	status: 200, headers: { 'content-type': 'application/json' },
});

/**
 * A scripted Telegram. `queue` holds the callback_query objects getUpdates
 * hands back, one batch per poll.
 */
function fakeTelegram({ queue = [], onSend } = {}) {
	const sent = [];
	let updateId = 100;
	// The client mints a random nonce per prompt and only honours callbacks
	// carrying it, so the fake learns the real one from the buttons it was
	// asked to render. Tests write 'NONCE' and it is substituted here.
	let nonce = null;
	const fetchImpl = vi.fn(async (url, init) => {
		const method = url.split('/').pop();
		const body = JSON.parse(init.body);
		if (method === 'sendMessage') {
			sent.push(body);
			const data = body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
			if (data) nonce = data.split(':')[1];
			onSend?.(body);
			return ok({ message_id: sent.length });
		}
		if (method === 'getUpdates') {
			const batch = queue.shift();
			if (!batch) return ok([]);
			const query = { ...batch, data: String(batch.data).replace('NONCE', nonce ?? 'NONCE') };
			return ok([{ update_id: updateId++, callback_query: query }]);
		}
		if (method === 'getMe') return ok({ username: 'relaybot', id: 7 });
		return ok(true);
	});
	return { fetchImpl, sent };
}

const plan = {
	spec: { name: 'Test Coin', symbol: 'TEST' },
	summary: ['launchpad   PAIR', 'total       0.0008 ETH'],
	warnings: [],
};

const callback = (over = {}) => ({
	id: 'cb1',
	data: 'approve:NONCE',
	message: { chat: { id: '555' } },
	from: { id: '42', username: 'operator' },
	...over,
});

describe('createTelegramClient', () => {
	it('refuses to build without a token or chat', () => {
		expect(() => createTelegramClient({ chatId: '1' })).toThrow(/bot token/);
		expect(() => createTelegramClient({ token: 't' })).toThrow(/chatId/);
	});

	it('resolves approved when the configured chat taps Approve', async () => {
		const { fetchImpl } = fakeTelegram({ queue: [callback()] });
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		const decision = await client.ask('launch?', { timeoutMs: 2_000 });
		expect(decision.approved).toBe(true);
		expect(decision.by).toBe('@operator');
	});

	it('resolves rejected on a Reject tap', async () => {
		const { fetchImpl } = fakeTelegram({ queue: [callback({ data: 'reject:NONCE' })] });
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		expect((await client.ask('launch?', { timeoutMs: 2_000 })).approved).toBe(false);
	});

	it('denies when nobody answers in time', async () => {
		const { fetchImpl } = fakeTelegram({ queue: [] });
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		const decision = await client.ask('launch?', { timeoutMs: 150 });
		expect(decision).toMatchObject({ approved: false, reason: 'timed out' });
		client.stop();
	});

	it('ignores an approval from a different chat', async () => {
		const { fetchImpl } = fakeTelegram({
			queue: [callback({ message: { chat: { id: '999' } } })],
		});
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		const decision = await client.ask('launch?', { timeoutMs: 200 });
		expect(decision.approved).toBe(false);
		client.stop();
	});

	it('ignores an approval from a user outside the allowlist', async () => {
		const { fetchImpl } = fakeTelegram({ queue: [callback({ from: { id: '999' } })] });
		const client = createTelegramClient({ token: 't', chatId: '555', allowedUserIds: ['42'], fetchImpl });
		const decision = await client.ask('launch?', { timeoutMs: 200 });
		expect(decision.approved).toBe(false);
		client.stop();
	});

	it('accepts an allowlisted user', async () => {
		const { fetchImpl } = fakeTelegram({ queue: [callback()] });
		const client = createTelegramClient({ token: 't', chatId: '555', allowedUserIds: ['42'], fetchImpl });
		expect((await client.ask('launch?', { timeoutMs: 2_000 })).approved).toBe(true);
	});

	it('ignores a callback whose nonce belongs to no live prompt', async () => {
		// 'STALE' contains no 'NONCE' marker, so the fake passes it through
		// unchanged and the client sees a nonce it never issued.
		const { fetchImpl } = fakeTelegram({ queue: [callback({ data: 'approve:STALE' })] });
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		const decision = await client.ask('launch?', { timeoutMs: 200 });
		expect(decision.approved).toBe(false);
		client.stop();
	});

	it('sends the prompt with both buttons', async () => {
		const { fetchImpl, sent } = fakeTelegram({ queue: [callback()] });
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		await client.ask('launch?', { timeoutMs: 2_000 });
		const keyboard = sent[0].reply_markup.inline_keyboard[0];
		expect(keyboard.map((b) => b.text)).toEqual(['Approve', 'Reject']);
	});

	it('truncates a message too long for the Bot API', async () => {
		const { fetchImpl, sent } = fakeTelegram();
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		await client.send('x'.repeat(9_000));
		expect(sent[0].text.length).toBeLessThan(4_096);
	});
});

describe('createTelegramApproval', () => {
	it('approves the plan when the tap comes back approved', async () => {
		const { fetchImpl } = fakeTelegram({ queue: [callback()] });
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		const approve = createTelegramApproval({ client, timeoutMs: 2_000, log: nullLogger });
		expect(await approve(plan)).toBe(true);
	});

	it('denies when the transport throws', async () => {
		const client = { ask: async () => { throw new Error('telegram down'); } };
		const approve = createTelegramApproval({ client, log: nullLogger });
		expect(await approve(plan)).toBe(false);
	});

	it('puts the wallet and cost in the message a human reads', async () => {
		const { fetchImpl, sent } = fakeTelegram({ queue: [callback()] });
		const client = createTelegramClient({ token: 't', chatId: '555', fetchImpl });
		await createTelegramApproval({ client, timeoutMs: 2_000, log: nullLogger })(plan);
		expect(sent[0].text).toContain('0.0008 ETH');
		expect(sent[0].text).toContain('TEST');
	});
});

describe('requireAll', () => {
	it('needs every approver to agree', async () => {
		expect(await requireAll([async () => true, async () => true])(plan)).toBe(true);
		expect(await requireAll([async () => true, async () => false])(plan)).toBe(false);
	});

	it('stops asking after the first refusal', async () => {
		const second = vi.fn(async () => true);
		await requireAll([async () => false, second])(plan);
		expect(second).not.toHaveBeenCalled();
	});
});

describe('createStandingApproval', () => {
	it('approves and leaves a record of what it approved', async () => {
		const lines = [];
		const approve = createStandingApproval({
			render: () => 'PLAN BODY',
			log: { info: (l) => lines.push(l) },
		});
		expect(await approve(plan)).toBe(true);
		expect(lines.join(' ')).toContain('PLAN BODY');
		expect(lines.join(' ')).toContain('standing authorization');
	});
});
