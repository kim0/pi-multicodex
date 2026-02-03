/*
 * MultiCodex Extension
 *
 * Rotates multiple ChatGPT Codex OAuth accounts for the built-in
 * openai-codex-responses API.
 *
 * Note: The published @mariozechner/pi-coding-agent types do not expose the
 * extension surface yet. We import ExtensionAPI as a type and provide a local
 * module augmentation (pi-coding-agent.d.ts) so TypeScript can compile.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	loginOpenAICodex,
	type Model,
	type OAuthCredentials,
	refreshOpenAICodexToken,
	type SimpleStreamOptions,
	streamSimple,
} from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// =============================================================================
// Helpers
// =============================================================================

class LocalEventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;

	constructor(
		private isComplete: (event: T) => boolean,
		private extractResult: (event: T) => R,
	) {
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift();
			if (waiter) {
				waiter({ value: undefined as never, done: true });
			}
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				const next = this.queue.shift();
				if (!next) {
					continue;
				}
				yield next;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) =>
					this.waiting.push(resolve),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

class LocalAssistantMessageEventStream extends LocalEventStream<
	AssistantMessageEvent,
	AssistantMessage
> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

export function isQuotaErrorMessage(message: string): boolean {
	return /\b429\b|quota|usage limit|rate.?limit|too many requests|limit reached/i.test(
		message,
	);
}

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return typeof err === "string" ? err : JSON.stringify(err);
}

function createErrorAssistantMessage(
	model: Model<Api>,
	message: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

type FooterTheme = {
	fg: (token: string, text: string) => string;
};

type FooterData = {
	getGitBranch: () => string | null;
	getAvailableProviderCount: () => number;
	onBranchChange?: (callback: () => void) => () => void;
};

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function stripAnsi(text: string): string {
	const ansiPattern = "\\u001b\\[[0-9;]*m";
	const ansiRegex = new RegExp(ansiPattern, "g");
	return text.replace(ansiRegex, "");
}

function isAssistantMessageEntry(entry: {
	type: string;
	message?: AssistantMessage;
}): entry is { type: "message"; message: AssistantMessage } {
	return entry.type === "message" && entry.message?.role === "assistant";
}

function buildFooterLines(
	width: number,
	theme: FooterTheme,
	footerData: FooterData,
	ctx: ExtensionContext,
	statusText?: string,
): string[] {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	const entries = ctx.sessionManager.getEntries() as Array<{
		type: string;
		message?: AssistantMessage;
	}>;

	for (const entry of entries) {
		if (isAssistantMessageEntry(entry)) {
			const message = entry.message;
			totalInput += message.usage.input;
			totalOutput += message.usage.output;
			totalCacheRead += message.usage.cacheRead;
			totalCacheWrite += message.usage.cacheWrite;
			totalCost += message.usage.cost.total;
		}
	}

	const lastAssistantMessage = [...entries]
		.reverse()
		.find(
			(entry) =>
				isAssistantMessageEntry(entry) &&
				entry.message.stopReason !== "aborted",
		)?.message;

	const contextTokens = lastAssistantMessage
		? lastAssistantMessage.usage.input +
			lastAssistantMessage.usage.output +
			lastAssistantMessage.usage.cacheRead +
			lastAssistantMessage.usage.cacheWrite
		: 0;
	const contextWindow = ctx.model?.contextWindow || 0;
	const contextPercentValue =
		contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
	const contextPercent = contextPercentValue.toFixed(1);

	let pwd = process.cwd();
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && pwd.startsWith(home)) {
		pwd = `~${pwd.slice(home.length)}`;
	}

	const branch = footerData.getGitBranch();
	if (branch) {
		pwd = `${pwd} (${branch})`;
	}

	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) {
		pwd = `${pwd} • ${sessionName}`;
	}

	if (pwd.length > width) {
		const half = Math.floor(width / 2) - 2;
		if (half > 0) {
			const start = pwd.slice(0, half);
			const end = pwd.slice(-(half - 1));
			pwd = `${start}...${end}`;
		} else {
			pwd = pwd.slice(0, Math.max(1, width));
		}
	}

	const statsParts = [];
	if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
	if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
	if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
	if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
	if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

	let contextPercentStr: string;
	const contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}`;
	if (contextPercentValue > 90) {
		contextPercentStr = theme.fg("error", contextPercentDisplay);
	} else if (contextPercentValue > 70) {
		contextPercentStr = theme.fg("warning", contextPercentDisplay);
	} else {
		contextPercentStr = contextPercentDisplay;
	}
	statsParts.push(contextPercentStr);

	let statsLeft = statsParts.join(" ");
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		const plainStatsLeft = stripAnsi(statsLeft);
		statsLeft = `${plainStatsLeft.substring(0, width - 3)}...`;
		statsLeftWidth = visibleWidth(statsLeft);
	}

	const modelName = ctx.model?.id || "no-model";
	let rightSideWithoutProvider = modelName;
	if (ctx.model?.reasoning) {
		const thinkingLevel = ctx.thinkingLevel || "off";
		rightSideWithoutProvider =
			thinkingLevel === "off"
				? `${modelName} • thinking off`
				: `${modelName} • ${thinkingLevel}`;
	}

	let rightSide = rightSideWithoutProvider;
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
		if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
			rightSide = rightSideWithoutProvider;
		}
	}

	const statusPrefix = statusText ? `${sanitizeStatusText(statusText)} • ` : "";
	const rightSideWithStatus = statusPrefix
		? `${statusPrefix}${rightSide}`
		: rightSide;

	const rightSideWidth = visibleWidth(rightSideWithStatus);
	const totalNeeded = statsLeftWidth + 2 + rightSideWidth;

	let statsLine: string;
	if (totalNeeded <= width) {
		const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
		statsLine = statsLeft + padding + rightSideWithStatus;
	} else {
		const availableForRight = width - statsLeftWidth - 2;
		if (availableForRight > 3) {
			const plainRightSide = stripAnsi(rightSideWithStatus);
			const truncatedPlain = plainRightSide.substring(0, availableForRight);
			const padding = " ".repeat(
				width - statsLeftWidth - truncatedPlain.length,
			);
			statsLine = statsLeft + padding + truncatedPlain;
		} else {
			statsLine = statsLeft;
		}
	}

	const dimStatsLeft = theme.fg("dim", statsLeft);
	const remainder = statsLine.slice(statsLeft.length);
	const dimRemainder = theme.fg("dim", remainder);

	return [theme.fg("dim", pwd), dimStatsLeft + dimRemainder].map((line) =>
		truncateToWidth(line, width, theme.fg("dim", "...")),
	);
}

async function openLoginInBrowser(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	url: string,
): Promise<void> {
	let command: string;
	let args: string[];

	if (process.platform === "darwin") {
		command = "open";
		args = [url];
	} else if (process.platform === "win32") {
		command = "cmd";
		args = ["/c", "start", "", url];
	} else {
		command = "xdg-open";
		args = [url];
	}

	try {
		await pi.exec(command, args);
	} catch (error) {
		ctx.ui.notify(
			"Could not open a browser automatically. Please open the login URL manually.",
			"warning",
		);
		console.warn("[multicodex] Failed to open browser:", error);
	}
}

// =============================================================================
// Storage
// =============================================================================

interface Account {
	email: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	lastUsed?: number;
	quotaExhaustedUntil?: number;
}

interface StorageData {
	accounts: Account[];
	activeEmail?: string;
}

const STORAGE_FILE = path.join(os.homedir(), ".pi", "agent", "multicodex.json");
const PROVIDER_ID = "multicodex";
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// =============================================================================
// Account Manager
// =============================================================================

export class AccountManager {
	private data: StorageData;

	constructor() {
		this.data = this.load();
	}

	private load(): StorageData {
		try {
			if (fs.existsSync(STORAGE_FILE)) {
				return JSON.parse(
					fs.readFileSync(STORAGE_FILE, "utf-8"),
				) as StorageData;
			}
		} catch (e) {
			console.error("Failed to load multicodex accounts:", e);
		}
		return { accounts: [] };
	}

	private save(): void {
		try {
			const dir = path.dirname(STORAGE_FILE);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(STORAGE_FILE, JSON.stringify(this.data, null, 2));
		} catch (e) {
			console.error("Failed to save multicodex accounts:", e);
		}
	}

	getAccounts(): Account[] {
		return this.data.accounts;
	}

	getAccount(email: string): Account | undefined {
		return this.data.accounts.find((a) => a.email === email);
	}

	addOrUpdateAccount(email: string, creds: OAuthCredentials): void {
		const existing = this.getAccount(email);
		if (existing) {
			existing.accessToken = creds.access;
			existing.refreshToken = creds.refresh;
			existing.expiresAt = creds.expires;
			existing.quotaExhaustedUntil = undefined;
		} else {
			this.data.accounts.push({
				email,
				accessToken: creds.access,
				refreshToken: creds.refresh,
				expiresAt: creds.expires,
			});
		}
		this.setActiveAccount(email);
		this.save();
	}

	getActiveAccount(): Account | undefined {
		// 1) Selected account (if not exhausted)
		if (this.data.activeEmail) {
			const account = this.getAccount(this.data.activeEmail);
			if (
				account &&
				(!account.quotaExhaustedUntil ||
					account.quotaExhaustedUntil < Date.now())
			) {
				return account;
			}
		}

		// 2) Any valid account
		const valid = this.data.accounts.filter(
			(a) => !a.quotaExhaustedUntil || a.quotaExhaustedUntil < Date.now(),
		);
		if (valid.length > 0) return valid[0];

		// 3) All exhausted -> earliest cooldown expiry
		if (this.data.accounts.length > 0) {
			return [...this.data.accounts].sort(
				(a, b) => (a.quotaExhaustedUntil || 0) - (b.quotaExhaustedUntil || 0),
			)[0];
		}

		return undefined;
	}

	setActiveAccount(email: string): void {
		if (this.getAccount(email)) {
			this.data.activeEmail = email;
			this.save();
		}
	}

	markExhausted(email: string): void {
		const account = this.getAccount(email);
		if (account) {
			account.quotaExhaustedUntil = Date.now() + QUOTA_COOLDOWN_MS;
			this.save();
		}
	}

	rotateRandomly(): Account | undefined {
		const available = this.data.accounts.filter(
			(a) => !a.quotaExhaustedUntil || a.quotaExhaustedUntil < Date.now(),
		);
		if (available.length === 0) return this.getActiveAccount();

		const random = available[Math.floor(Math.random() * available.length)];
		this.data.activeEmail = random.email;
		this.save();
		return random;
	}

	async ensureValidToken(account: Account): Promise<string> {
		// Valid for at least 5 more mins
		if (Date.now() < account.expiresAt - 5 * 60 * 1000) {
			return account.accessToken;
		}

		const result = await refreshOpenAICodexToken(account.refreshToken);
		this.addOrUpdateAccount(account.email, result);
		return result.access;
	}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function multicodexExtension(pi: ExtensionAPI) {
	const accountManager = new AccountManager();
	let footerInstalled = false;
	let footerRender: (() => void) | undefined;
	let footerContext: ExtensionContext | undefined;
	let statusText: string | undefined;

	const ensureFooter = (ctx: ExtensionContext): void => {
		footerContext = ctx;
		if (footerInstalled) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			footerRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange
				? footerData.onBranchChange(() => tui.requestRender())
				: undefined;

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					if (!footerContext) return [];
					return buildFooterLines(
						width,
						theme as FooterTheme,
						footerData,
						footerContext,
						statusText,
					);
				},
			};
		});

		footerInstalled = true;
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		ensureFooter(ctx);
		const active = accountManager.getActiveAccount();
		if (!active) {
			statusText = `${PROVIDER_ID}: No account`;
			footerRender?.();
			return;
		}

		const status =
			active.quotaExhaustedUntil && active.quotaExhaustedUntil > Date.now()
				? `${active.email} (Quota Hit)`
				: active.email;
		statusText = `${PROVIDER_ID}: ${status}`;
		footerRender?.();
	};

	// Provider registration
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "https://chatgpt.com/backend-api/codex",
		apiKey: "managed-by-extension",
		api: "openai-codex-responses",
		streamSimple: createStreamWrapper(accountManager),
		models: [
			{
				id: `${PROVIDER_ID}/gpt-5.2-codex`,
				name: "Multi-Codex GPT-5.2",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
			{
				id: `${PROVIDER_ID}/gpt-5.1-codex-mini`,
				name: "Multi-Codex GPT-5.1 Mini",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	});

	// Login command
	pi.registerCommand("multicodex-login", {
		description: "Login to an OpenAI Codex account for the rotation pool",
		handler: async (
			args: string,
			ctx: ExtensionCommandContext,
		): Promise<void> => {
			const email = args.trim();
			if (!email) {
				ctx.ui.notify(
					"Please provide an email/identifier: /multicodex-login my@email.com",
					"error",
				);
				return;
			}

			try {
				ctx.ui.notify(
					`Starting login for ${email}... Check your browser.`,
					"info",
				);

				const creds = await loginOpenAICodex({
					onAuth: ({ url }) => {
						void openLoginInBrowser(pi, ctx, url);
						ctx.ui.notify(`Please open this URL to login: ${url}`, "info");
						console.log(`[multicodex] Login URL: ${url}`);
					},
					onPrompt: async ({ message }) => (await ctx.ui.input(message)) || "",
				});

				accountManager.addOrUpdateAccount(email, creds);
				ctx.ui.notify(`Successfully logged in as ${email}`, "info");
				updateStatus(ctx);
			} catch (e) {
				ctx.ui.notify(`Login failed: ${getErrorMessage(e)}`, "error");
			}
		},
	});

	// Switch active account
	pi.registerCommand("multicodex-use", {
		description: "Switch active Codex account",
		handler: async (
			_args: string,
			ctx: ExtensionCommandContext,
		): Promise<void> => {
			const accounts = accountManager.getAccounts();
			if (accounts.length === 0) {
				ctx.ui.notify(
					"No accounts logged in. Use /multicodex-login first.",
					"warning",
				);
				return;
			}

			const options = accounts.map(
				(a) =>
					a.email +
					(a.quotaExhaustedUntil && a.quotaExhaustedUntil > Date.now()
						? " (Quota)"
						: ""),
			);
			const selected = await ctx.ui.select("Select Account", options);
			if (!selected) return;

			const email = selected.split(" ")[0];
			accountManager.setActiveAccount(email);
			updateStatus(ctx);
			ctx.ui.notify(`Switched to ${email}`, "info");
		},
	});

	// Hooks
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		if (
			!accountManager.getActiveAccount() &&
			accountManager.getAccounts().length > 0
		) {
			accountManager.rotateRandomly();
		}
		updateStatus(ctx);
	});

	pi.on(
		"session_switch",
		(event: { reason?: string }, ctx: ExtensionContext) => {
			if (event.reason === "new") {
				accountManager.rotateRandomly();
				updateStatus(ctx);
			}
		},
	);
}

// =============================================================================
// Stream Wrapper
// =============================================================================

const MAX_ROTATION_RETRIES = 5;

export function createStreamWrapper(accountManager: AccountManager) {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream =
			new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream;

		(async () => {
			try {
				for (let attempt = 0; attempt <= MAX_ROTATION_RETRIES; attempt++) {
					const account = accountManager.getActiveAccount();
					if (!account) {
						throw new Error(
							"No available Multicodex accounts. Please use /multicodex-login.",
						);
					}

					const token = await accountManager.ensureValidToken(account);

					const internalModel: Model<"openai-codex-responses"> = {
						...(model as Model<"openai-codex-responses">),
						id: model.id.includes("gpt-5.1")
							? "gpt-5.1-codex-mini"
							: "gpt-5.2-codex",
						api: "openai-codex-responses",
						provider: model.provider,
					};

					const inner = streamSimple(
						{
							...internalModel,
							headers: {
								...(internalModel.headers || {}),
								"X-Multicodex-Account": account.email,
							},
						},
						context,
						{
							...options,
							apiKey: token,
						},
					);

					let forwardedAny = false;
					let retry = false;

					for await (const event of inner) {
						if (event.type === "error") {
							const msg = event.error.errorMessage || "";
							const isQuota = isQuotaErrorMessage(msg);

							if (isQuota && !forwardedAny && attempt < MAX_ROTATION_RETRIES) {
								accountManager.markExhausted(account.email);
								accountManager.rotateRandomly();
								retry = true;
								break;
							}

							stream.push(event);
							stream.end();
							return;
						}

						forwardedAny = true;
						stream.push(event);

						if (event.type === "done") {
							stream.end();
							return;
						}
					}

					if (retry) {
						continue;
					}

					// If inner finished without done/error, stop to avoid hanging.
					stream.end();
					return;
				}
			} catch (e) {
				const message = getErrorMessage(e);
				const errorEvent: AssistantMessageEvent = {
					type: "error",
					reason: "error",
					error: createErrorAssistantMessage(
						model,
						`Multicodex failed: ${message}`,
					),
				};
				stream.push(errorEvent);
				stream.end();
			}
		})();

		return stream;
	};
}
