import { getModels } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type Account,
	type AccountManager,
	buildMulticodexProviderConfig,
	getNextResetAt,
	getOpenAICodexMirror,
	isQuotaErrorMessage,
	isUsageUntouched,
	parseCodexUsageResponse,
	pickBestAccount,
} from "./index";

describe("isQuotaErrorMessage", () => {
	it("matches 429", () => {
		expect(isQuotaErrorMessage("HTTP 429 Too Many Requests")).toBe(true);
	});

	it("matches common quota / usage limit messages", () => {
		expect(isQuotaErrorMessage("You have hit your ChatGPT usage limit.")).toBe(
			true,
		);
		expect(isQuotaErrorMessage("Quota exceeded")).toBe(true);
	});

	it("matches rate limit phrasing", () => {
		expect(isQuotaErrorMessage("rate limit exceeded")).toBe(true);
		expect(isQuotaErrorMessage("Rate-Limit: exceeded")).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isQuotaErrorMessage("network error")).toBe(false);
		expect(isQuotaErrorMessage("bad request")).toBe(false);
	});
});

describe("getOpenAICodexMirror", () => {
	it("mirrors the openai-codex provider models exactly (metadata)", () => {
		const sourceModels = getModels("openai-codex");
		const expected = {
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

		expect(getOpenAICodexMirror()).toEqual(expected);
	});
});

describe("buildMulticodexProviderConfig", () => {
	it("uses mirrored models and baseUrl", () => {
		const mirror = getOpenAICodexMirror();
		const config = buildMulticodexProviderConfig(
			{} as unknown as AccountManager,
		);

		expect(config.api).toBe("openai-codex-responses");
		expect(config.apiKey).toBe("managed-by-extension");
		expect(config.baseUrl).toBe(mirror.baseUrl);
		expect(config.models).toEqual(mirror.models);
		expect(typeof config.streamSimple).toBe("function");
	});
});

function makeAccount(email: string, overrides?: Partial<Account>): Account {
	return {
		email,
		accessToken: "token",
		refreshToken: "refresh",
		expiresAt: 0,
		...overrides,
	};
}

describe("usage helpers", () => {
	it("parses usage response windows", () => {
		const response = parseCodexUsageResponse({
			rate_limit: {
				primary_window: {
					reset_at: 1700000000,
					used_percent: 12.5,
				},
				secondary_window: {
					reset_at: 1700003600,
					used_percent: 0,
				},
			},
		});

		expect(response.primary?.usedPercent).toBe(12.5);
		expect(response.primary?.resetAt).toBe(1700000000 * 1000);
		expect(response.secondary?.usedPercent).toBe(0);
		expect(response.secondary?.resetAt).toBe(1700003600 * 1000);
	});

	it("detects untouched usage", () => {
		expect(
			isUsageUntouched({
				primary: { usedPercent: 0, resetAt: 1 },
				secondary: { usedPercent: 0, resetAt: 2 },
				fetchedAt: 0,
			}),
		).toBe(true);
		expect(
			isUsageUntouched({
				primary: { usedPercent: 0, resetAt: 1 },
				secondary: { usedPercent: 5, resetAt: 2 },
				fetchedAt: 0,
			}),
		).toBe(false);
	});

	it("picks earliest reset from usage", () => {
		expect(
			getNextResetAt({
				primary: { resetAt: 2000 },
				secondary: { resetAt: 1000 },
				fetchedAt: 0,
			}),
		).toBe(1000);
	});
});

describe("pickBestAccount", () => {
	it("prefers untouched accounts when available", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 10, resetAt: 5000 },
					secondary: { usedPercent: 10, resetAt: 6000 },
					fetchedAt: 0,
				},
			],
			[
				"b",
				{
					primary: { usedPercent: 0, resetAt: 4000 },
					secondary: { usedPercent: 0, resetAt: 7000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("b");
	});

	it("prefers earliest reset when all accounts touched", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 10, resetAt: 5000 },
					secondary: { usedPercent: 10, resetAt: 8000 },
					fetchedAt: 0,
				},
			],
			[
				"b",
				{
					primary: { usedPercent: 20, resetAt: 3000 },
					secondary: { usedPercent: 20, resetAt: 9000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("b");
	});

	it("falls back to available account when usage is unknown", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const selected = pickBestAccount(accounts, new Map(), { now: 0 });
		expect(["a", "b"]).toContain(selected?.email);
	});

	it("ignores exhausted accounts", () => {
		const accounts = [
			makeAccount("a", { quotaExhaustedUntil: 2000 }),
			makeAccount("b"),
		];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 0, resetAt: 1000 },
					secondary: { usedPercent: 0, resetAt: 1000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 1000 });
		expect(selected?.email).toBe("b");
	});
});
