import { describe, expect, it } from "vitest";

import { isQuotaErrorMessage } from "./index";

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
