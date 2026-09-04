// TypeScript declarations for launch-relay.
//
// The runtime is plain JavaScript with JSDoc; this file is the contract a
// TypeScript consumer codes against. Adapter interfaces come first, because
// implementing one of them is the whole extension story: a new venue, chain, or
// trigger is a Source or a Target and nothing else changes.

declare module 'launch-relay' {
	// ── core data ────────────────────────────────────────────────────────────

	export interface SignalMetrics {
		marketCapUsd?: number | null;
		athMarketCapUsd?: number | null;
		liquiditySol?: number | null;
		/** Age of the originating asset at signal time, in seconds. */
		ageSeconds?: number | null;
		creatorLaunches?: number | null;
		replyCount?: number | null;
	}

	export interface SocialLinks {
		twitter?: string | null;
		telegram?: string | null;
		website?: string | null;
	}

	/** Something that happened elsewhere and might be worth launching a coin about. */
	export interface Signal {
		/** Stable dedupe key, unique per source. */
		id: string;
		source: string;
		kind: string;
		chain: string;
		/** Event time, epoch ms. */
		at: number;
		name?: string;
		symbol?: string;
		description?: string;
		imageUrl?: string | null;
		address?: string | null;
		creator?: string | null;
		url?: string | null;
		links?: SocialLinks;
		metrics?: SignalMetrics;
		raw?: Record<string, unknown>;
		/** Set by the backtester. Forward-looking numbers live in `outcome`, never `metrics`. */
		historical?: boolean;
		outcome?: { athMarketCapUsd: number | null; marketCapUsd: number | null; createdAt: number | null };
	}

	export interface LaunchOrigin {
		source: string;
		chain: string;
		address?: string | null;
		url?: string | null;
		signalId: string;
	}

	/** What to launch, in venue-neutral terms. */
	export interface LaunchSpec {
		name: string;
		symbol: string;
		description: string;
		imageUrl: string | null;
		links: SocialLinks;
		origin: LaunchOrigin;
		targetHints?: Record<string, unknown>;
	}

	export interface LaunchCost {
		nativeSymbol: string;
		feeNative: string;
		gasNative: string;
		totalNative: string;
		totalBase: bigint;
	}

	/** A priced, fully prepared launch that has not been signed. */
	export interface LaunchPlan {
		target: string;
		chain: string;
		chainId: number;
		spec: LaunchSpec;
		wallet: string;
		contract: string;
		cost: LaunchCost;
		warnings: string[];
		dryRun?: boolean;
		call: Record<string, unknown>;
		summary: string[];
		markets?: MarketSelection;
		metadata?: { metadataURI: string; metadataHash?: string; imageUrl?: string | null };
	}

	export interface LaunchResult {
		ok: boolean;
		txHash?: string;
		tokenAddress?: string | null;
		url?: string | null;
		explorerUrl?: string | null;
		error?: string;
	}

	// ── adapters ─────────────────────────────────────────────────────────────

	export interface Logger {
		debug(...args: unknown[]): void;
		info(...args: unknown[]): void;
		warn(...args: unknown[]): void;
		error(...args: unknown[]): void;
		child?(scope: string): Logger;
	}

	/** Implement `start` for a push feed, `poll` for anything listable. */
	export interface Source {
		id: string;
		chain: string;
		start?(
			onSignal: (signal: Signal) => void,
			ctx: { signal: AbortSignal; log: Logger },
		): (() => void) | Promise<() => void>;
		poll?(ctx: { log: Logger }): Promise<Signal[]>;
		pollIntervalMs?: number;
	}

	/** A launchpad. `plan` prices, `execute` signs exactly what was priced. */
	export interface Target {
		id: string;
		chain: string;
		chainId: number;
		nativeSymbol: string;
		nativeDecimals: number;
		viemChain?: unknown;
		api?: PairFundApi;
		symbolTaken?(symbol: string): Promise<boolean>;
		health?(): Promise<{ ok: boolean; detail: string }>;
		plan(spec: LaunchSpec, ctx: { wallet: WalletHandle; log: Logger; dryRun?: boolean }): Promise<LaunchPlan>;
		execute(plan: LaunchPlan, ctx: { wallet: WalletHandle; log: Logger }): Promise<LaunchResult>;
	}

	export interface WalletHandle {
		address: string;
		label: string;
		signer: unknown;
		balance(): Promise<bigint>;
		client?: unknown;
		publicClient?: unknown;
		connection?: unknown;
	}

	export interface WalletPool {
		chain: string;
		list(): WalletHandle[];
		pick(opts?: { minBalance?: bigint; exclude?: string[] }): Promise<WalletHandle | null>;
		markUsed(address: string, at?: number): void;
		usage?: Map<string, { lastUsedAt: number; launches: number }>;
	}

	export interface Store {
		seen(key: string): Promise<boolean>;
		mark(key: string): Promise<void>;
		record(record: Record<string, unknown>): Promise<void>;
		history(opts?: { since?: number }): Promise<Record<string, unknown>[]>;
		paths?: { dir: string; seen: string; launches: string };
	}

	// ── configuration ────────────────────────────────────────────────────────

	export interface RuleConfig {
		kinds?: string[];
		minMarketCapUsd?: number | null;
		maxMarketCapUsd?: number | null;
		minAthMarketCapUsd?: number | null;
		maxSignalAgeSeconds?: number | null;
		maxAssetAgeSeconds?: number | null;
		minReplyCount?: number | null;
		maxCreatorLaunches?: number | null;
		requireImage?: boolean;
		requireSocials?: 'none' | 'any' | 'twitter';
		denyWords?: string[];
		symbolAllow?: string[];
		symbolDeny?: string[];
		creatorDeny?: string[];
		custom?(signal: Signal): string | null | Promise<string | null>;
	}

	export interface MapperConfig {
		nameTemplate?: string;
		symbolTemplate?: string;
		descriptionTemplate?: string;
		attributionTemplate?: string | null;
		symbolMax?: number;
		nameMax?: number;
		carryLinks?: boolean;
		carryImage?: boolean;
		hints?(spec: LaunchSpec, signal: Signal): Record<string, unknown> | Promise<Record<string, unknown>>;
	}

	export interface BudgetConfig {
		maxLaunchesPerHour?: number | null;
		maxLaunchesPerDay?: number | null;
		maxLaunchesPerWalletPerDay?: number | null;
		cooldownMs?: number;
		walletCooldownMs?: number;
		/** Whole native units, e.g. '0.01'. */
		maxSpendPerLaunch?: string | null;
		maxSpendPerDay?: string | null;
		minWalletReserve?: string;
		/** Halt while this path exists. */
		killSwitchFile?: string;
	}

	export type MarketStrategy = 'thematic' | 'fixed' | 'least-crowded' | 'popular' | 'random';

	export interface MarketSelectorConfig {
		strategy?: MarketStrategy;
		markets?: string[];
		weights?: number[];
		/** Maximum markets a non-fixed strategy picks. PAIR allows one to five. */
		count?: number;
		fallback?: string[];
		minThemeScore?: number;
		themes?: Record<string, string[]>;
		random?(): number;
	}

	export interface MarketSelection {
		markets: { symbol: string; address: string; weightBps: number; decimals: number }[];
		strategy: string;
		rationale: string;
	}

	export type RotationStrategy =
		| 'round-robin' | 'least-recently-used' | 'least-used' | 'random' | 'richest' | 'sticky';

	// ── engine ───────────────────────────────────────────────────────────────

	export interface RelayOptions {
		sources: Source[];
		target: Target;
		wallets: WalletPool;
		/** Defaults to 'dry-run'. Live mode requires `confirm`. */
		mode?: 'dry-run' | 'live';
		confirm?(plan: LaunchPlan): Promise<boolean>;
		rules?: RuleConfig;
		mapper?: MapperConfig;
		budget?: BudgetConfig;
		store?: Store;
		logger?: Logger;
		avoidSymbolCollision?: boolean;
		onLaunch?(event: { signal: Signal; spec: LaunchSpec; plan: LaunchPlan; result: LaunchResult }): void;
		onSkip?(event: { signal: Signal; reason: string; details?: string[]; plan?: LaunchPlan | null }): void;
		onFailure?(event: { signal: Signal; spec: LaunchSpec; plan: LaunchPlan; result: LaunchResult }): void;
	}

	export interface Relay {
		mode: 'dry-run' | 'live';
		dryRun: boolean;
		target: Target;
		store: Store;
		handleSignal(signal: Signal): Promise<{ status: string; [k: string]: unknown }>;
		runOnce(): Promise<Record<string, unknown>[]>;
		start(): () => void;
		stop(): void;
	}

	export function createRelay(opts: RelayOptions): Relay;

	// ── sources ──────────────────────────────────────────────────────────────

	export interface PumpFunSourceOptions {
		/** three.ws SSE rung. Default true. */
		stream?: boolean;
		/** PumpPortal websocket rung. Default true. */
		pumpPortal?: boolean;
		/** HTTP backfill rung. Default true. */
		backfill?: boolean;
		baseUrl?: string;
		pollIntervalMs?: number;
		backfillLimit?: number;
		/** Emit the first backfill page on start. Default false. */
		emitBacklog?: boolean;
	}

	export function createPumpFunGraduationSource(opts?: PumpFunSourceOptions): Source;
	export function normalizeGraduation(raw: Record<string, unknown>): Signal | null;
	export function enrichSignal(signal: Signal): Promise<Signal>;
	export function createManualSource(entries: Partial<Signal>[], opts?: { kind?: string; chain?: string }): Source;

	// ── targets ──────────────────────────────────────────────────────────────

	export interface PairFundTargetOptions {
		rpcUrl?: string;
		launchpad?: string;
		apiBase?: string;
		marketSelector?: MarketSelectorConfig;
		deadlineSeconds?: number;
		creatorFeeRecipient?: string;
		api?: PairFundApi;
	}

	export function createPairFundTarget(opts?: PairFundTargetOptions): Target;

	export interface PairFundApi {
		baseUrl: string;
		health(): Promise<{ status: string }>;
		stockTokens(): Promise<Record<string, unknown>[]>;
		tokens(query?: Record<string, unknown>): Promise<{ items: Record<string, unknown>[] }>;
		token(address: string): Promise<Record<string, unknown>>;
		trending(): Promise<Record<string, unknown>[]>;
		platformStats(): Promise<Record<string, unknown>>;
		symbolTaken(symbol: string): Promise<boolean>;
		mirrorImage(url: string): Promise<string | null>;
		uploadMetadata(meta: Record<string, unknown>): Promise<{ metadataURI: string; metadataHash: string }>;
		registerLaunch(txHash: string, wait?: { timeoutMs?: number; intervalMs?: number }): Promise<string | null>;
		waitForIndex(address: string, wait?: { timeoutMs?: number; intervalMs?: number }): Promise<boolean>;
		feesClaimable(wallet: string): Promise<Record<string, unknown>[]>;
		feesPending(wallet: string): Promise<Record<string, unknown>[]>;
		feesHistory(wallet: string): Promise<Record<string, unknown>[]>;
		walletTokens(wallet: string): Promise<{ items: Record<string, unknown>[] }>;
	}

	export function createPairFundApi(opts?: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): PairFundApi;

	export interface PumpFunTargetOptions {
		rpcUrl?: string;
		/** Creator's own first buy, in SOL. Default 0. */
		initialBuySol?: number;
		priorityFeeSol?: number;
		apiUrl?: string;
	}

	export function createPumpFunTarget(opts?: PumpFunTargetOptions): Target;

	// ── market pairing ───────────────────────────────────────────────────────

	export function createMarketSelector(opts?: MarketSelectorConfig): {
		select(spec: LaunchSpec, stockTokens: Record<string, unknown>[]): MarketSelection;
		strategy: string;
	};
	export function scoreMarkets(
		spec: { name?: string; symbol?: string; description?: string },
		themes?: Record<string, string[]>,
	): { symbol: string; score: number; matched: string[] }[];
	export function evenWeights(n: number): number[];
	export const MARKET_THEMES: Readonly<Record<string, string[]>>;

	// ── wallets ──────────────────────────────────────────────────────────────

	export interface EvmWalletPoolOptions {
		chain: unknown;
		rpcUrl?: string;
		mnemonic?: string;
		/** Accounts to derive from the mnemonic. Default 3. */
		count?: number;
		startIndex?: number;
		privateKeys?: string[];
		keyFile?: string;
		strategy?: RotationStrategy;
	}

	export function createEvmWalletPool(opts: EvmWalletPoolOptions): Promise<WalletPool>;
	export function createSolanaWalletPool(opts?: {
		rpcUrl?: string; secretKeys?: string[]; keyFile?: string; strategy?: RotationStrategy;
	}): Promise<WalletPool>;
	export function pickWallet<T extends { address: string }>(
		candidates: T[],
		opts?: {
			strategy?: RotationStrategy;
			usage?: Map<string, { lastUsedAt: number; launches: number }>;
			balances?: Map<string, bigint>;
			random?(): number;
			cursor?: number;
		},
	): { wallet: T | null; cursor: number };
	export const STRATEGIES: RotationStrategy[];

	export function planFunding(opts: {
		wallets: WalletPool; target: string; reserve?: string; from?: string;
	}): Promise<{
		from: { address: string; label: string; balance: bigint };
		transfers: { to: string; label: string; amount: bigint; have: bigint }[];
		totalWei: bigint;
		shortfallWei: bigint;
		summary: string[];
	}>;
	export function executeFunding(opts: {
		plan: Awaited<ReturnType<typeof planFunding>>; wallets: WalletPool; chain: unknown; log: Logger;
	}): Promise<{ to: string; amount: bigint; txHash: string; ok: boolean }[]>;

	// ── rules, mapping, budget ───────────────────────────────────────────────

	export function createRules(config?: RuleConfig): {
		evaluate(signal: Signal, now?: number): Promise<{ pass: boolean; reasons: string[] }>;
		config: RuleConfig;
	};
	export function createMapper(config?: MapperConfig): {
		map(signal: Signal): Promise<LaunchSpec>;
		config: MapperConfig;
	};
	export function createBudget(
		config?: BudgetConfig,
		chain?: { decimals?: number; nativeSymbol?: string },
	): {
		check(input: {
			costBase: bigint; wallet: string; walletBalance: bigint;
			history?: Record<string, unknown>[]; now?: number;
		}): { ok: boolean; reason: string | null; spentTodayBase: bigint };
		config: BudgetConfig;
		decimals: number;
		nativeSymbol: string;
		reserve: bigint;
		format(base: bigint): string;
	};

	export function sanitizeName(raw: string, max?: number): string;
	export function sanitizeSymbol(rawSymbol: string, rawName?: string, max?: number): string;
	export function sanitizeDescription(raw: string, max?: number): string;
	export function uniqueSymbol(
		base: string,
		isTaken: (symbol: string) => Promise<boolean>,
		opts?: { max?: number; attempts?: number },
	): Promise<string | null>;
	export function render(template: string, vars: Record<string, string | number>): string;

	// ── backtesting ──────────────────────────────────────────────────────────

	export interface BacktestReport {
		/** Rules switched off because the historical record cannot answer them. */
		untestedRules: string[];
		window: { from: number | null; to: number | null; hours: number };
		scanned: number;
		passed: number;
		rejected: number;
		launched: number;
		throttled: number;
		passRate: number;
		rejectionReasons: { reason: string; count: number }[];
		cost: { perLaunchBase: bigint; totalBase: bigint; nativeSymbol: string; decimals: number };
		selection: {
			selected: { count: number; median: number | null; p75: number | null; best: number | null };
			rejected: { count: number; median: number | null; p75: number | null; best: number | null };
			medianLift: number | null;
		};
		pairing: { symbol: string; count: number; themed: number }[];
		plans: { signal: Signal; spec?: LaunchSpec; selection?: MarketSelection; error?: string }[];
		best: { symbol?: string; name?: string; athMarketCapUsd: number | null; pairing: string | null }[];
		missed: { symbol?: string; athMarketCapUsd: number | null }[];
	}

	export function fetchGraduationHistory(opts?: {
		limit?: number; pauseMs?: number; onProgress?(msg: string): void;
	}): Promise<Signal[]>;
	export function toHistoricalSignal(coin: Record<string, unknown>): Signal | null;
	export function backtest(opts: {
		signals: Signal[];
		rules?: RuleConfig;
		mapper?: MapperConfig;
		budget?: BudgetConfig;
		marketSelector?: { select(spec: LaunchSpec, markets: Record<string, unknown>[]): MarketSelection };
		markets?: Record<string, unknown>[];
		costPerLaunch?: bigint;
		decimals?: number;
		nativeSymbol?: string;
		walletCount?: number;
	}): Promise<BacktestReport>;
	export const UNBACKTESTABLE_RULES: readonly string[];

	// ── fees and portfolio ───────────────────────────────────────────────────

	export interface ClaimableFee {
		symbol: string;
		assetAddress: string;
		lockerAddress: string;
		amount: bigint;
		decimals: number;
		amountFormatted: string;
		amountUsd: number | null;
		assetType: string;
		projectTokenAddress: string | null;
	}

	export function fetchClaimable(api: PairFundApi, wallet: string): Promise<ClaimableFee[]>;
	export function fetchPending(api: PairFundApi, wallet: string): Promise<Record<string, unknown>[]>;
	export function planClaims(opts: { rows: ClaimableFee[]; wallet: WalletHandle }): Promise<{
		claims: (ClaimableFee & { gas: bigint; gasCost: bigint; simulated: boolean })[];
		totalGas: bigint;
		gasPrice: bigint;
		summary: string[];
	}>;
	export function executeClaims(opts: {
		claims: Record<string, unknown>[]; wallet: WalletHandle; chain: unknown; log: Logger;
	}): Promise<{ symbol: string; amount: bigint; ok: boolean; txHash?: string; error?: string }[]>;

	export interface Position {
		symbol: string;
		name: string | null;
		tokenAddress: string;
		wallet: string;
		launchedAt: number;
		costNative: string;
		costBase: bigint;
		txHash: string | null;
		marketCapUsd: number | null;
		priceUsd: number | null;
		liquidityUsd: number | null;
		volume24hUsd: number | null;
		holders: number | null;
		graduated: boolean;
		graduationProgress: number | null;
		pairedWith: string[];
		indexed: boolean;
		url: string;
		origin: string | null;
		originUrl: string | null;
	}

	export function buildPortfolio(opts: {
		store: Store; api: PairFundApi; decimals?: number; nativeSymbol?: string;
	}): Promise<{ positions: Position[]; totals: Record<string, unknown> }>;
	export function summarizeEconomics(opts: {
		portfolio: { totals: Record<string, unknown> };
		claimable?: ClaimableFee[];
		pending?: Record<string, unknown>[];
		history?: Record<string, unknown>[];
	}): Record<string, unknown>;

	// ── approvals and notifications ──────────────────────────────────────────

	export interface TelegramClient {
		send(text: string): Promise<unknown>;
		ask(text: string, opts?: { timeoutMs?: number }): Promise<{ approved: boolean; by: string; reason: string }>;
		check(): Promise<{ username: string; id: number }>;
		stop(): void;
	}

	export function createTelegramClient(opts: {
		token: string;
		chatId: string | number;
		/** Users permitted to approve. Empty means anyone in the chat. */
		allowedUserIds?: (string | number)[];
		fetchImpl?: typeof fetch;
	}): TelegramClient;

	export function createWebhookTransport(opts: {
		url: string; headers?: Record<string, string>; format?: 'json' | 'discord' | 'slack';
	}): { send(text: string, event: Record<string, unknown>): Promise<void> };

	export function createNotifier(
		transports: { send(text: string, event: Record<string, unknown>): Promise<unknown> }[],
		opts?: { logger?: Logger },
	): {
		transports: unknown[];
		enabled: boolean;
		launched(event: Record<string, unknown>): Promise<void>;
		failed(event: Record<string, unknown>): Promise<void>;
		halted(event: { reason: string }): Promise<void>;
		status(text: string): Promise<void>;
	};

	export function buildTransports(config?: Record<string, unknown>, env?: Record<string, string | undefined>): unknown[];

	/** Tap-to-approve from a phone. Fails closed on timeout or an unreachable chat. */
	export function createTelegramApproval(opts: {
		client: TelegramClient; timeoutMs?: number; log?: Logger;
	}): (plan: LaunchPlan) => Promise<boolean>;
	export function createTerminalApproval(opts: { render(plan: LaunchPlan): string }): (plan: LaunchPlan) => Promise<boolean>;
	export function createStandingApproval(opts: { render(plan: LaunchPlan): string; log?: Logger }): (plan: LaunchPlan) => Promise<boolean>;
	export function requireAll(approvers: ((plan: LaunchPlan) => Promise<boolean>)[]): (plan: LaunchPlan) => Promise<boolean>;

	// ── reporting ────────────────────────────────────────────────────────────

	export function renderPlan(plan: LaunchPlan): string;
	export function renderBacktest(report: BacktestReport): string;
	export function renderPositions(portfolio: Record<string, unknown>, economics?: Record<string, unknown>): string;
	export function renderFees(claimable: ClaimableFee[], pending: Record<string, unknown>[]): string;
	export function usd(n: number | null): string;
	export function pct(fraction: number | null): string;
	export function createDashboard(opts: Record<string, unknown>): {
		hooks: { onLaunch(event: unknown): void; onSkip(event: unknown): void };
		start(): void;
		stop(): void;
		push(kind: string, text: string): void;
	};

	// ── stores, config, logging ──────────────────────────────────────────────

	export function createFileStore(dir: string): Promise<Store>;
	export function createMemoryStore(): Store;
	export function createLogger(scope: string, opts?: { level?: 'debug' | 'info' | 'warn' | 'error'; sink?(line: string): void }): Logger;
	export const nullLogger: Logger;

	export function loadConfig(path?: string): Promise<Record<string, unknown>>;
	export function buildRelay(config: Record<string, unknown>, overrides?: {
		mode?: 'dry-run' | 'live';
		confirm?(plan: LaunchPlan): Promise<boolean>;
		logger?: Logger;
		env?: Record<string, string | undefined>;
		onLaunch?(event: unknown): void;
		onSkip?(event: unknown): void;
		onFailure?(event: unknown): void;
	}): Promise<{
		relay: Relay; target: Target; wallets: WalletPool; sources: Source[]; store: Store; log: Logger; mode: string;
	}>;

	export const DEFAULT_CONFIG: Readonly<Record<string, unknown>>;
	export const DEFAULT_RULES: Readonly<RuleConfig>;
	export const DEFAULT_BUDGET: Readonly<BudgetConfig>;
	export const DEFAULT_TEMPLATES: Readonly<Record<string, string>>;

	// ── presets ──────────────────────────────────────────────────────────────

	export const presets: {
		/** pump.fun graduations on Solana into PAIR launches on Robinhood Chain. */
		pumpfunToPairfund(opts?: {
			mnemonic?: string;
			privateKeys?: string[];
			wallets?: number;
			strategy?: RotationStrategy;
			mode?: 'dry-run' | 'live';
			confirm?(plan: LaunchPlan): Promise<boolean>;
			rules?: RuleConfig;
			mapper?: MapperConfig;
			budget?: BudgetConfig;
			markets?: MarketSelectorConfig;
			source?: PumpFunSourceOptions;
			ledgerDir?: string;
			rpcUrl?: string;
			logger?: Logger;
			onLaunch?(event: unknown): void;
			onSkip?(event: unknown): void;
		}): Promise<{ relay: Relay; target: Target; wallets: WalletPool; source: Source; store: Store; log: Logger }>;

		/** pump.fun graduations into any launchpad in the Robinhood Chain catalog. */
		pumpfunToRobinhoodVenue(opts: {
			venue: string;
			mnemonic?: string;
			privateKeys?: string[];
			wallets?: number;
			mode?: 'dry-run' | 'live';
			confirm?(plan: LaunchPlan): Promise<boolean>;
			metadata?: MetadataHost;
			buyAmount?: string | number;
			creator?: string;
			rules?: RuleConfig;
			mapper?: MapperConfig;
			budget?: BudgetConfig;
			source?: PumpFunSourceOptions;
			ledgerDir?: string;
			rpcUrl?: string;
			logger?: Logger;
		}): Promise<{ relay: Relay; target: Target; wallets: WalletPool; source: Source; store: Store; log: Logger }>;

		/** pump.fun graduations into a Uniswap pool you open yourself. */
		pumpfunToPool(opts?: {
			amm?: AmmId;
			quote?: string;
			poolType?: PoolType;
			fee?: number;
			supply?: bigint | number | string;
			startPrice?: string | number;
			startFdv?: string | number;
			quoteAmount?: string | number;
			rangeMultiple?: number;
			hooks?: string;
			factory?: string;
			mnemonic?: string;
			privateKeys?: string[];
			wallets?: number;
			mode?: 'dry-run' | 'live';
			confirm?(plan: LaunchPlan): Promise<boolean>;
			rules?: RuleConfig;
			mapper?: MapperConfig;
			budget?: BudgetConfig;
			source?: PumpFunSourceOptions;
			ledgerDir?: string;
			rpcUrl?: string;
			logger?: Logger;
		}): Promise<{ relay: Relay; target: Target; wallets: WalletPool; source: Source; store: Store; log: Logger }>;
	};

	// ── Robinhood Chain: venues, pools, discovery ────────────────────────────

	/** A field of a venue's launch call that this toolkit fills in rather than replays. */
	export type LaunchRole =
		| 'name' | 'symbol' | 'description' | 'imageUrl' | 'metadataUri' | 'metadataHash'
		| 'twitter' | 'telegram' | 'website' | 'discord' | 'creator' | 'salt'
		| 'quoteToken' | 'buyAmount';

	export interface VenueBinding {
		role: LaunchRole;
		/** Index path into the decoded argument tree. */
		path: number[];
		/** ABI type of the leaf at that path. */
		type: string;
	}

	/**
	 * How to call one launchpad, learned from a transaction that already
	 * launched a token on it. `launch.template` is that transaction's decoded
	 * arguments; a launch replaces the bound leaves and replays the rest.
	 */
	export interface VenueDescriptor {
		id: string;
		label: string | null;
		address: string;
		chainId: 4663;
		kind: string;
		selector: string;
		usable: boolean;
		/** Present when `usable` is false: why this venue cannot be driven. */
		reason?: string;
		implementation?: string | null;
		url?: string | null;
		labelSource?: 'curated' | 'geckoterminal' | 'none';
		labelEvidence?: string;
		overrideReason?: string;
		quote?: { token: string; symbol: string; decimals: number } | null;
		approval?: { spenderIsVenue?: boolean; amountRole?: LaunchRole } | null;
		observed: { launches: number; firstBlock: number; lastBlock: number };
		/** Present when the catalog was built with --simulate. */
		liveCheck?: { ok: boolean; checkedAt: string; reason?: string; revert?: string };
		probe?: { ok: boolean; account: string; at?: string; accepted?: LaunchRole[]; rejected?: Array<{ role: string; path: number[]; revert: string | null; detail: string; note?: string }> };
		/** More than one non-zero bytes32 argument: only a probe can tell which is a salt. */
		ambiguousSalt?: number;
		launch: {
			signature: string;
			selector: string;
			/** Wei sent with the call: the floor observed across every launch seen. */
			value: string;
			valueObserved?: { min: string; max: string; samples: number };
			template: unknown[];
			bindings: VenueBinding[];
		};
		/** What a live simulation proved about this venue's substitutable fields. */
		probe?: {
			ok: boolean;
			account: string;
			at?: string;
			accepted?: LaunchRole[];
			revert?: string | null;
			rejected?: Array<{ role: LaunchRole; path: number[]; revert: string | null; detail?: string; note?: string }>;
		};
		liveCheck?: { ok: boolean; reason?: string; checkedAt: string; revert?: string };
		evidence: {
			txHash: string;
			blockNumber: number;
			token: string;
			name: string | null;
			symbol: string | null;
			decimals: number | null;
			creator: string;
			input: string;
			/** Bytes appended after the ABI payload by the original caller, never replayed. */
			trailer?: string;
		};
	}

	export const catalog: {
		chainId: 4663;
		chain: string;
		generatedAt: string;
		window: { fromBlock: number; toBlock: number };
		tokensScanned: number;
		venues: VenueDescriptor[];
	};
	export const CATALOG_META: { generatedAt: string; window: { fromBlock: number; toBlock: number }; tokensScanned: number; chainId: 4663 };
	export function listVenues(filter?: { kind?: string; usable?: boolean; minLaunches?: number }): readonly VenueDescriptor[];
	export function findVenue(idOrAddress: string): VenueDescriptor | null;
	/** Like `findVenue`, but throws on anything a launch cannot be built from. */
	export function requireVenue(idOrAddress: string): VenueDescriptor;
	export function venueKinds(): string[];

	export function verifyDescriptor(descriptor: VenueDescriptor): { ok: boolean; reason?: string; encoded?: string; expected?: string };
	export function buildArgs(descriptor: VenueDescriptor, values?: Partial<Record<LaunchRole, unknown>>): unknown[];
	export function encodeLaunchCall(descriptor: VenueDescriptor, values?: Partial<Record<LaunchRole, unknown>>): {
		address: string; abi: readonly unknown[]; functionName: string; args: unknown[]; value: bigint; data: string;
	};
	export function describeBindings(descriptor: VenueDescriptor): string[];
	export function argumentTypes(signature: string): string[];
	export const LAUNCH_ROLES: readonly LaunchRole[];
	export const CALLER_ROLES: readonly LaunchRole[];

	/** Where a launched token's descriptor document lives. */
	export interface MetadataHost {
		id: string;
		publish(spec: LaunchSpec): Promise<{ metadataURI: string; metadataHash: string; imageUrl: string | null; hosted?: boolean }>;
	}
	export function inlineMetadataHost(opts?: { maxBytes?: number }): MetadataHost;
	export function fixedMetadataHost(uri: string): MetadataHost;
	export function launchpadMetadataHost(opts: { api: { uploadMetadata: Function; mirrorImage?: Function }; mirrorImage?: boolean }): MetadataHost;
	export function buildDescriptorDocument(spec: LaunchSpec): Record<string, string>;

	/** Drive any launchpad in the catalog. */
	export function createRobinhoodVenueTarget(opts: {
		venue: string | VenueDescriptor;
		rpcUrl?: string;
		metadata?: MetadataHost;
		planTtlMs?: number;
		creator?: string;
		buyAmount?: string | number;
		values?: Partial<Record<LaunchRole, unknown>>;
		publicClient?: unknown;
	}): Target;

	export type AmmId = 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4';
	export type PoolType = 'full-range' | 'single-sided';

	/** Deploy a fixed-supply token and open its pool yourself. */
	export function createPoolLaunchTarget(opts?: {
		amm?: AmmId;
		quote?: string;
		poolType?: PoolType;
		fee?: number;
		tickSpacing?: number;
		hooks?: string;
		supply?: bigint | number | string;
		decimals?: number;
		supplyInPoolPct?: number;
		startPrice?: string | number;
		startFdv?: string | number;
		quoteAmount?: string | number;
		rangeMultiple?: number;
		factory?: string;
		rpcUrl?: string;
		stepGas?: bigint;
		deadlineSeconds?: number;
		publicClient?: unknown;
	}): Target;

	export const TOKENS: { readonly WETH: string; readonly USDG: string; readonly VIRTUAL: string };
	export const INFRA: { readonly PERMIT2: string; readonly MULTICALL3: string; readonly ENTRY_POINT_V07: string };
	export const AMMS: Record<AmmId, Record<string, unknown>>;
	export const AMM_FORKS: { readonly v2: readonly string[]; readonly v3: readonly string[] };
	export const NATIVE_ADDRESS: string;

	// Pool arithmetic, exported because a caller pricing a launch needs it too.
	export function encodeSqrtPriceX96(amount1: bigint, amount0: bigint): bigint;
	export function sqrtPriceX96AtTick(tick: number): bigint;
	export function priceToTick(price: number): number;
	export function tickToPrice(tick: number): number;
	export function alignTick(tick: number, spacing: number, direction?: 'down' | 'up' | 'nearest'): number;
	export function fullRange(spacing: number): { tickLower: number; tickUpper: number };
	export function singleSidedRange(opts: { currentTick: number; spacing: number; multiple?: number }): { tickLower: number; tickUpper: number };
	export function liquidityForAmounts(opts: {
		sqrtPriceX96: bigint; sqrtPriceLowerX96: bigint; sqrtPriceUpperX96: bigint; amount0: bigint; amount1: bigint;
	}): bigint;
	export function sortTokens(tokenA: string, tokenB: string): { token0: string; token1: string; flipped: boolean };

	// Rebuilding the catalog.
	export function scanMints(opts: { client: unknown; fromBlock: bigint; toBlock: bigint; chunk?: bigint; onProgress?(msg: string): void }): Promise<Array<{ token: string; txHash: string; blockNumber: bigint }>>;
	export function groupByLauncher(opts: { client: unknown; mints: unknown[]; onProgress?(msg: string): void }): Promise<unknown[]>;
	export function groupsFromTransactions(opts: { client: unknown; txHashes: string[]; onProgress?(msg: string): void }): Promise<unknown[]>;
	export function mergeGroups(...sets: unknown[][]): unknown[];
	export function lookupSignatures(selectors: string[], opts?: { fetchImpl?: typeof fetch; overrides?: Record<string, string> }): Promise<Record<string, string | null>>;
	export function buildDescriptor(opts: { client: unknown; group: unknown; signature: string | null; id?: string; label?: string }): Promise<VenueDescriptor>;
	export function inferBindings(opts: { args: unknown[]; types: string[]; facts: { name?: string; symbol?: string; creator?: string } }): VenueBinding[];
	export function labelVenues(descriptors: VenueDescriptor[], opts?: { fetchImpl?: typeof fetch | null; onProgress?(msg: string): void; delayMs?: number }): Promise<VenueDescriptor[]>;
	export function lookupDex(token: string, opts?: { fetchImpl?: typeof fetch }): Promise<{ id: string; name: string } | null>;
	export function mintedToken(receipt: { logs?: Array<{ address: string; topics: string[]; data: string }> }): string | null;
	export function mintedTokenFromLogs(logs: Array<{ address: string; topics: string[]; data: string }>): string | null;
	export function classifyLaunchFunction(signature: string): { launch: boolean; reason?: string };
	export const PROBE_ACCOUNT: string;
	/**
	 * Test every substitution a descriptor claims to support against the live
	 * contract, keeping the ones it accepts and pruning the ones it reverts on.
	 * Runs entirely inside `eth_call` with a balance state override: nothing is
	 * signed and no funds are needed.
	 */
	export function probeDescriptor(opts: { client: unknown; descriptor: VenueDescriptor; account?: string }): Promise<VenueDescriptor & {
		probe?: { ok: boolean; account: string; at?: string; accepted?: LaunchRole[]; rejected?: Array<{ role: string; path: number[]; revert: string | null; detail: string; note?: string }> };
	}>;
	/**
	 * Prove, one binding at a time, that a venue really accepts the fields the
	 * descriptor claims to fill in. Prunes the ones it refuses and records why.
	 */
	export function probeDescriptor(opts: { client: unknown; descriptor: VenueDescriptor; account?: string }): Promise<VenueDescriptor>;
	export const PROBE_ACCOUNT: string;

	// ── the Relay protocol ───────────────────────────────────────────────────

	/** A lock that never opens. Mirrors LiquidityLocker.PERMANENT. */
	export const PERMANENT: bigint;

	export interface ContractArtifact {
		contract: string;
		source: string;
		compiler: string;
		abi: readonly unknown[];
		bytecode: string;
	}

	export const ARTIFACTS: {
		launchToken: ContractArtifact;
		liquidityLocker: ContractArtifact;
		launchRegistry: ContractArtifact;
		relayLauncher: ContractArtifact;
		uniswapV2Adapter: ContractArtifact;
		uniswapV3Adapter: ContractArtifact;
	};
	export const ADAPTERS: Record<AmmId, { artifact: ContractArtifact; label: string; args(): string[] }>;

	export interface DeploymentStep {
		label: string;
		kind: 'deploy' | 'call';
		to?: string;
		from?: string;
		data: string;
		value: bigint;
		gas: bigint;
	}

	/** Every address a deployment will produce, known before the first transaction. */
	export function buildDeployment(opts: {
		deployer: string;
		owner?: string;
		feeCollector?: string;
		amms?: AmmId[];
		nonce?: number | bigint;
	}): {
		addresses: { locker: string; registry: string; launcher: string; adapters: Record<string, string> };
		steps: DeploymentStep[];
	};

	/** Turn a description of a launch into the struct RelayLauncher takes. */
	export function buildLaunch(opts: {
		launcher: string;
		creator: string;
		adapter: string;
		amm: AmmId;
		token: { name: string; symbol: string; metadataURI?: string; decimals?: number; supply?: bigint };
		salt: string;
		pool?: {
			type?: PoolType;
			fee?: number;
			quote?: string;
			quoteAmount?: bigint;
			startFdv?: number;
			startPrice?: number;
			rangeMultiple?: number;
			supplyToPoolPct?: number;
		};
		unlockAt?: bigint | number;
		feeRecipient?: string;
	}): { tokenAddress: string; describe: string; params: Record<string, unknown>; nativeValue: bigint };

	export function predictLaunchToken(opts: {
		launcher: string;
		creator: string;
		salt: string;
		token: { name: string; symbol: string; decimals: number; supply: bigint; metadataURI: string };
	}): string;

	/** Run a sequence of transactions on top of the current block without sending them. */
	export function simulateSteps(opts: {
		client: unknown;
		from: string;
		steps: DeploymentStep[];
		balance?: bigint;
		stateOverrides?: Record<string, object>;
		retries?: number;
	}): Promise<{
		ok: boolean;
		gasUsed: number;
		results: Array<{ label: string; ok: boolean; gasUsed: number; codeSize: number | null; returnData: string; logs: unknown[]; error: string | null; revertData: string | null }>;
	}>;

	export const deployments: {
		note: string;
		chains: Record<string, {
			chain: string;
			deployedAt: string | null;
			deployer: string | null;
			locker: string | null;
			registry: string | null;
			launcher: string | null;
			adapters: Record<string, string>;
			transactions: Array<{ label: string; hash: string }>;
		}>;
	};

	// ── measuring an ERC-20's storage layout ─────────────────────────────────

	export function findErc20Slots(opts: { client: unknown; token: string; holder: string; spender: string; maxSlot?: number }):
		Promise<{ balanceSlot: number | null; allowanceSlot: number | null }>;
	export function fundOverride(opts: { client: unknown; token: string; holder: string; spender: string; amount?: bigint }):
		Promise<Array<{ address: string; stateDiff: Array<{ slot: string; value: string }> }>>;
	export function mappingSlot(holder: string, slot: number): string;
	export function nestedMappingSlot(owner: string, spender: string, slot: number): string;
	export function isErc20(client: unknown, address: string): Promise<boolean>;
	export function clearSlotCache(): void;
	export function toBase64(text: string): string;

	// ── chain constants ──────────────────────────────────────────────────────

	export const ROBINHOOD_CHAIN_ID: 4663;
	export const PAIR_LAUNCHPAD_V5: string;
	export const PAIR_V4_LOCKER: string;
	export const PAIR_API_BASE: string;
	export const launchpadAbi: readonly unknown[];
	export const lockerAbi: readonly unknown[];
	export function robinhoodChain(opts?: { rpcUrl?: string }): unknown;

	// ── shared plumbing ──────────────────────────────────────────────────────

	export function fetchImageBytes(
		url: string,
		opts?: { timeoutMs?: number; fetchImpl?: typeof fetch; maxBytes?: number },
	): Promise<{ data: Uint8Array; contentType: string } | null>;
	export function fetchJson(url: string, init?: RequestInit & { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<unknown>;
	export function isPrivateHost(hostname: string): boolean;
}
