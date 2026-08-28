// The relay loop.
//
// Sources push or poll Signals in; this decides, one at a time, whether each
// one becomes a launch. The order of the stages is the design:
//
//   dedupe -> rules -> map -> symbol -> wallet -> plan -> budget -> confirm -> execute
//
// Cheap and local first, expensive and irreversible last. Dedupe and rules
// cost nothing and reject most of the firehose. Planning costs network calls
// and an upload. Only the final stage spends money, and it is preceded by two
// independent brakes: a budget that a human configured, and a confirmation
// callback that must actively say yes.
//
// Signals are processed serially by default. Wallet selection, budget checks,
// and the daily spend total all read shared state, and a race between two
// launches is exactly how caps get exceeded.

import { createBudget } from './budget.js';
import { createMapper } from './mapping.js';
import { createRules } from './rules.js';
import { createMemoryStore } from './store/memory.js';
import { createLogger } from './log.js';
import { uniqueSymbol } from './symbols.js';

const MAX_QUEUE = 500;
const MAX_ATTEMPTS = 3;

/**
 * @param {object} opts
 * @param {import('./types.js').Source[]} opts.sources
 * @param {import('./types.js').Target} opts.target
 * @param {import('./types.js').WalletPool} opts.wallets
 * @param {'dry-run'|'live'} [opts.mode]              Default 'dry-run'.
 * @param {(plan: import('./types.js').LaunchPlan) => Promise<boolean>} [opts.confirm]
 *        Required in live mode. Receives the priced plan and returns whether to sign it.
 * @param {object} [opts.rules]                       RuleConfig, or a built rules object.
 * @param {object} [opts.mapper]                      MapperConfig, or a built mapper.
 * @param {object} [opts.budget]                      BudgetConfig.
 * @param {import('./types.js').Store} [opts.store]
 * @param {import('./types.js').Logger} [opts.logger]
 * @param {boolean} [opts.avoidSymbolCollision]       Default true.
 * @param {(result: object) => void} [opts.onLaunch]
 * @param {(skip: object) => void} [opts.onSkip]
 * @param {(failure: object) => void} [opts.onFailure]
 */
export function createRelay(opts) {
	const {
		sources, target, wallets,
		mode = 'dry-run', confirm,
		store = createMemoryStore(),
		avoidSymbolCollision = true,
		onLaunch, onSkip, onFailure,
	} = opts;

	if (!sources?.length) throw new Error('createRelay needs at least one source');
	if (!target) throw new Error('createRelay needs a target');
	if (!wallets) throw new Error('createRelay needs a wallet pool');
	if (mode === 'live' && typeof confirm !== 'function') {
		throw new Error(
			'live mode requires a confirm callback. The relay will not sign a launch that nothing approved.',
		);
	}

	const log = opts.logger || createLogger('relay');
	const rules = opts.rules?.evaluate ? opts.rules : createRules(opts.rules);
	const mapper = opts.mapper?.map ? opts.mapper : createMapper(opts.mapper);
	const budget = opts.budget?.check
		? opts.budget
		: createBudget(opts.budget, { decimals: target.nativeDecimals ?? 18, nativeSymbol: target.nativeSymbol });

	const dryRun = mode !== 'live';
	const attempts = new Map();
	const queue = [];
	/** @type {Promise<void>|null} */
	let draining = null;
	let controller = null;
	let stops = [];
	let pollTimers = [];

	async function handleSignal(signal) {
		const scope = `${signal.symbol || '?'} ${signal.address || signal.id}`;

		if (await store.seen(signal.id)) return skip(signal, 'duplicate', ['already processed']);

		const verdict = await rules.evaluate(signal);
		if (!verdict.pass) {
			await store.mark(signal.id);
			return skip(signal, 'filtered', verdict.reasons);
		}

		let spec;
		try {
			spec = await mapper.map(signal);
		} catch (err) {
			await store.mark(signal.id);
			return skip(signal, 'unmappable', [message(err)]);
		}

		if (avoidSymbolCollision && typeof target.symbolTaken === 'function') {
			try {
				const free = await uniqueSymbol(spec.symbol, (s) => target.symbolTaken(s), {
					max: mapper.config?.symbolMax ?? 10,
				});
				if (!free) {
					await store.mark(signal.id);
					return skip(signal, 'symbol-exhausted', [`every variant of ${spec.symbol} is taken on ${target.id}`]);
				}
				if (free !== spec.symbol) log.info(`${scope}: symbol ${spec.symbol} taken, using ${free}`);
				spec.symbol = free;
			} catch (err) {
				// A collision check that cannot run is not a launch blocker, but
				// the operator should know the ticker is unverified.
				log.warn(`${scope}: symbol availability unknown (${message(err)})`);
			}
		}

		// Only the reserve is required to shortlist a wallet. The precise
		// affordability test needs the plan's real cost, and that is what
		// budget.check does a few lines below.
		let wallet = await wallets.pick({ minBalance: budget.reserve });
		let underfunded = false;
		if (!wallet) {
			// A dry run signs nothing, so an empty pool is no reason to refuse to
			// show what would happen. Price the launch against the first wallet
			// and say plainly that it could not pay for it. Evaluating the relay
			// before funding anything is the normal first thing to do.
			if (!dryRun) return retryable(signal, 'no-wallet', ['no wallet in the pool has enough balance']);
			wallet = wallets.list()[0];
			if (!wallet) return skip(signal, 'no-wallet', ['the wallet pool is empty']);
			underfunded = true;
		}

		let plan;
		try {
			plan = await target.plan(spec, { wallet, log, dryRun });
		} catch (err) {
			return retryable(signal, 'plan-failed', [message(err)]);
		}

		const history = await store.history({ since: Date.now() - 86_400_000 });
		const check = budget.check({
			costBase: plan.cost.totalBase,
			wallet: wallet.address,
			walletBalance: await wallet.balance(),
			history,
		});

		if (dryRun) {
			// A dry run reports the budget verdict rather than obeying it. The
			// point of the mode is to see the whole decision, and "this would
			// have been stopped, here is why" is the most useful line in it.
			if (underfunded) plan.warnings.push('dry run: no wallet in the pool could fund this launch');
			if (!check.ok) plan.warnings.push(`dry run: the budget would stop this launch (${check.reason})`);
			await store.mark(signal.id);
			await store.record({
				status: 'planned', signalId: signal.id, target: target.id, wallet: wallet.address,
				symbol: spec.symbol, name: spec.name, costBase: plan.cost.totalBase.toString(),
				budgetBlock: check.ok ? null : check.reason,
				origin: spec.origin, plan: serializablePlan(plan),
			});
			log.info(
				`[dry-run] would launch ${spec.symbol} for ${plan.cost.totalNative} ${plan.cost.nativeSymbol} from ${wallet.label}`
				+ (check.ok ? '' : ` (blocked: ${check.reason})`),
			);
			for (const line of plan.summary) log.debug(`  ${line}`);
			onSkip?.({ signal, reason: 'dry-run', plan });
			return { status: 'planned', plan, budgetBlock: check.ok ? null : check.reason };
		}

		if (!check.ok) {
			// A budget stop is a condition, not a verdict on this coin: leaving
			// the signal unmarked lets it through once the window reopens.
			return skip(signal, 'budget', [check.reason], { keepUnseen: true, plan });
		}

		const approved = await confirm(plan);
		if (!approved) {
			await store.mark(signal.id);
			await store.record({
				status: 'declined', signalId: signal.id, target: target.id,
				wallet: wallet.address, symbol: spec.symbol, origin: spec.origin,
			});
			return skip(signal, 'declined', ['confirmation returned false']);
		}

		let result;
		try {
			result = await target.execute(plan, { wallet, log });
		} catch (err) {
			return retryable(signal, 'execute-failed', [message(err)]);
		}

		wallets.markUsed(wallet.address);
		await store.mark(signal.id);
		await store.record({
			status: result.ok ? 'launched' : 'failed',
			signalId: signal.id, target: target.id, chain: target.chain,
			wallet: wallet.address, symbol: spec.symbol, name: spec.name,
			costBase: plan.cost.totalBase.toString(), costNative: plan.cost.totalNative,
			txHash: result.txHash || null, tokenAddress: result.tokenAddress || null,
			url: result.url || null, origin: spec.origin, error: result.error || null,
		});

		if (result.ok) {
			log.info(`launched ${spec.symbol} -> ${result.tokenAddress || result.txHash} (${result.url || ''})`);
			onLaunch?.({ signal, spec, plan, result });
		} else {
			log.error(`launch failed for ${spec.symbol}: ${result.error}`);
			onFailure?.({ signal, spec, plan, result });
		}
		return { status: result.ok ? 'launched' : 'failed', result, plan };
	}

	function skip(signal, reason, details, { keepUnseen = false, plan = null } = {}) {
		log.info(`skip ${signal.symbol || signal.id}: ${reason}${details?.length ? ` (${details.join('; ')})` : ''}`);
		if (!keepUnseen) attempts.delete(signal.id);
		onSkip?.({ signal, reason, details, plan });
		return { status: 'skipped', reason, details };
	}

	// Transient failures (RPC hiccup, launchpad API blip) are retried a bounded
	// number of times and then given up on, so one poisoned signal cannot pin
	// the queue forever.
	function retryable(signal, reason, details) {
		const count = (attempts.get(signal.id) || 0) + 1;
		attempts.set(signal.id, count);
		if (count >= MAX_ATTEMPTS) {
			attempts.delete(signal.id);
			return store.mark(signal.id).then(() => skip(signal, `${reason}-giving-up`, details));
		}
		log.warn(`${signal.symbol || signal.id}: ${reason} (attempt ${count}/${MAX_ATTEMPTS}) ${details.join('; ')}`);
		return { status: 'retry', reason, details };
	}

	function enqueue(signal) {
		if (queue.length >= MAX_QUEUE) {
			log.warn(`queue full at ${MAX_QUEUE}, dropping ${signal.id}`);
			return;
		}
		queue.push(signal);
		drain();
	}

	// Returns the in-flight drain rather than resolving immediately, so
	// `runOnce` awaits the work its own enqueue kicked off instead of reading
	// an empty ledger while the queue is still being processed.
	function drain() {
		if (draining) return draining;
		draining = (async () => {
			try {
				while (queue.length) {
					const signal = queue.shift();
					try {
						await handleSignal(signal);
					} catch (err) {
						log.error(`unhandled error on ${signal.id}: ${message(err)}`);
					}
				}
			} finally {
				draining = null;
			}
		})();
		return draining;
	}

	return {
		mode,
		dryRun,
		target,
		store,
		handleSignal,

		/** Drain every source once and return. */
		async runOnce() {
			for (const source of sources) {
				if (typeof source.poll !== 'function') {
					log.warn(`source ${source.id} is push-only and has no poll; skipping in --once mode`);
					continue;
				}
				const signals = await source.poll({ log });
				log.info(`${source.id}: ${signals.length} signal(s)`);
				for (const signal of signals) enqueue(signal);
			}
			await drain();
			return store.history({ since: 0 });
		},

		/** Subscribe to every source and keep running until `stop()`. */
		start() {
			controller = new AbortController();
			for (const source of sources) {
				if (typeof source.start === 'function') {
					const stop = source.start(enqueue, { signal: controller.signal, log });
					stops.push(typeof stop === 'function' ? stop : () => {});
				} else if (typeof source.poll === 'function') {
					const interval = source.pollIntervalMs || 30_000;
					const tick = async () => {
						try {
							for (const signal of await source.poll({ log })) enqueue(signal);
						} catch (err) {
							log.warn(`${source.id} poll failed: ${message(err)}`);
						}
					};
					tick();
					pollTimers.push(setInterval(tick, interval));
				}
			}
			log.info(`relay started in ${mode} mode: ${sources.map((s) => s.id).join(', ')} -> ${target.id}`);
			return () => this.stop();
		},

		stop() {
			controller?.abort();
			for (const stop of stops) stop();
			for (const timer of pollTimers) clearInterval(timer);
			stops = [];
			pollTimers = [];
			log.info('relay stopped');
		},
	};
}

// Plans hold viem clients and bigints. The ledger keeps the human-readable
// half so a record stays readable years later without the code that made it.
function serializablePlan(plan) {
	return {
		target: plan.target,
		chain: plan.chain,
		chainId: plan.chainId,
		contract: plan.contract,
		cost: { ...plan.cost, totalBase: plan.cost.totalBase?.toString() },
		markets: plan.markets?.markets?.map((m) => ({ symbol: m.symbol, weightBps: m.weightBps })) || null,
		rationale: plan.markets?.rationale || null,
		metadata: plan.metadata || null,
		warnings: plan.warnings,
		summary: plan.summary,
	};
}

const message = (err) => err?.shortMessage || err?.message || String(err);
