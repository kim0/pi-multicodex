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
	createAssistantMessageEventStream,
	getApiProvider,
	getModels,
	loginOpenAICodex,
	type Model,
	type OAuthCredentials,
	refreshOpenAICodexToken,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// =============================================================================
// Helpers
// =============================================================================

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

export interface ProviderModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
}

export function getOpenAICodexMirror(): {
	baseUrl: string;
	models: ProviderModelDef[];
} {
	const sourceModels = getModels("openai-codex");
	return {
		baseUrl: sourceModels[0]?.baseUrl || "https://chatgpt.com/backend-api",
		models: sourceModels.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
	};
}

function createLinkedAbortController(signal?: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal?.aborted) {
		controller.abort();
		return controller;
	}
	signal?.addEventListener("abort", () => controller.abort(), { once: true });
	return controller;
}

function withProvider(
	event: AssistantMessageEvent,
	provider: string,
): AssistantMessageEvent {
	if ("partial" in event) {
		return { ...event, partial: { ...event.partial, provider } };
	}
	if (event.type === "done") {
		return { ...event, message: { ...event.message, provider } };
	}
	if (event.type === "error") {
		return { ...event, error: { ...event.error, provider } };
	}
	return event;
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

type ApiProviderRef = NonNullable<ReturnType<typeof getApiProvider>>;

export function buildMulticodexProviderConfig(accountManager: AccountManager): {
	baseUrl: string;
	apiKey: string;
	api: "openai-codex-responses";
	streamSimple: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	models: ProviderModelDef[];
} {
	const mirror = getOpenAICodexMirror();
	const baseProvider = getApiProvider("openai-codex-responses");
	if (!baseProvider) {
		throw new Error(
			"OpenAI Codex provider not available. Please update pi to include openai-codex support.",
		);
	}
	return {
		baseUrl: mirror.baseUrl,
		apiKey: "managed-by-extension",
		api: "openai-codex-responses",
		streamSimple: createStreamWrapper(accountManager, baseProvider),
		models: mirror.models,
	};
}

export default function multicodexExtension(pi: ExtensionAPI) {
	const accountManager = new AccountManager();

	pi.registerProvider(
		PROVIDER_ID,
		buildMulticodexProviderConfig(accountManager),
	);

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
			ctx.ui.notify(`Switched to ${email}`, "info");
		},
	});

	pi.registerCommand("multicodex-status", {
		description: "Show all Codex accounts and active status",
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

			const active = accountManager.getActiveAccount();
			const options = accounts.map((account) => {
				const isActive = active?.email === account.email;
				const quotaHit =
					account.quotaExhaustedUntil &&
					account.quotaExhaustedUntil > Date.now();
				const tags = [isActive ? "active" : null, quotaHit ? "quota" : null]
					.filter(Boolean)
					.join(", ");
				const suffix = tags ? ` (${tags})` : "";
				return `${isActive ? "•" : " "} ${account.email}${suffix}`;
			});

			await ctx.ui.select("MultiCodex Accounts", options);
		},
	});

	// Hooks
	pi.on("session_start", (_event: unknown, _ctx: ExtensionContext) => {
		if (
			!accountManager.getActiveAccount() &&
			accountManager.getAccounts().length > 0
		) {
			accountManager.rotateRandomly();
		}
	});

	pi.on(
		"session_switch",
		(event: { reason?: string }, _ctx: ExtensionContext) => {
			if (event.reason === "new") {
				accountManager.rotateRandomly();
			}
		},
	);
}

// =============================================================================
// Stream Wrapper
// =============================================================================

const MAX_ROTATION_RETRIES = 5;

export function createStreamWrapper(
	accountManager: AccountManager,
	baseProvider: ApiProviderRef,
) {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();

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

					const abortController = createLinkedAbortController(options?.signal);

					const internalModel: Model<"openai-codex-responses"> = {
						...(model as Model<"openai-codex-responses">),
						provider: "openai-codex",
						api: "openai-codex-responses",
					};

					const inner = baseProvider.streamSimple(
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
							signal: abortController.signal,
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
								abortController.abort();
								retry = true;
								break;
							}

							stream.push(withProvider(event, model.provider));
							stream.end();
							return;
						}

						forwardedAny = true;
						stream.push(withProvider(event, model.provider));

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
				stream.push(withProvider(errorEvent, model.provider));
				stream.end();
			}
		})();

		return stream;
	};
}
