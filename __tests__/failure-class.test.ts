import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_COOLDOWN_POLICY, classifyFailure, isQuotaExhausted } from "../src/fallback/index.ts";

// Real reasons from pi-model-alias-debug.jsonl on three hosts (2026-10-01..22).
const QUOTA = [
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
	'xai API error (403): 403 "You have run out of credits or need a Grok subscription."',
	'402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}',
	'429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
	'400 {"type":"error","error":{"message":"You have reached your specified workspace API usage limits"}}',
];
const ACCOUNT = [
	'Model alias "r" target "acct/a" is unavailable: OpenAI Codex token refresh failed (401): {"error":"x"}',
	'Model alias "r" target "acct/a" is unavailable: xAI OAuth token refresh failed (HTTP 400): invalid_grant: Invalid or unknown refresh token',
	'Model alias "r" target "acct/a" is unavailable: Failed to resolve API key for provider "acct" from shell command: age -d',
	"No API key for provider: acct",
	"Encountered invalidated oauth token for user, failing request",
];
const TRANSIENT = [
	'xai API error (503): 503 "Authentication is temporarily unavailable. Please retry."',
	"Streaming response failed: [429] Request rate limited",
	'500 {"error":{"message":"upstream said 401"}}',
	"latency timeout: no commit within 120000ms",
	"Codex error: Our servers are currently overloaded.",
];

test("real quota reasons classify as quota", () => {
	for (const reason of QUOTA) assert.equal(classifyFailure(reason), "quota", reason);
	assert.equal(isQuotaExhausted(QUOTA[0]!), true);
});

test("real account reasons classify as account", () => {
	for (const reason of ACCOUNT) assert.equal(classifyFailure(reason), "account", reason);
});

test("a bare HTTP 401 is account, a bare 403 is not", () => {
	assert.equal(classifyFailure("request failed", 401), "account");
	assert.equal(classifyFailure("request failed", 403), "transient");
});

test("5xx and 429 never classify as account", () => {
	for (const reason of TRANSIENT) assert.equal(classifyFailure(reason), "transient", reason);
	assert.equal(classifyFailure("No API key for provider: acct", 503), "transient");
	assert.equal(classifyFailure("invalid_grant", 429), "transient");
	assert.equal(
		classifyFailure('Model alias "r" target "acct/a" is unavailable: token refresh failed: {"error":"temporarily unavailable"}'),
		"transient",
	);
	assert.equal(classifyFailure('invalid_grant: {"message":"Request rate limited"}'), "transient");
});

test("quota text wins over an account status", () => {
	assert.equal(classifyFailure(QUOTA[0]!, 401), "quota");
});

test("account cooldown backs off from one hour to six", () => {
	assert.deepEqual(ACCOUNT_COOLDOWN_POLICY, { baseMs: 3_600_000, capMs: 21_600_000, resetSuccesses: 1 });
});
