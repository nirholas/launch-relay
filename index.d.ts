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
	};

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
