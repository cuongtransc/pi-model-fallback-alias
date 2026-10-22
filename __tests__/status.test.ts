import assert from "node:assert/strict";
import test from "node:test";
import {
	composeFooterStatus,
	formatCooldownStatus,
	formatDuration,
	formatFailoverWarning,
	formatFooterStatus,
} from "../src/status/status.ts";

test("formats a model-only footer", () => {
	assert.equal(formatFooterStatus("provider/sol", []), "provider/sol");
});

test("formats a model and cooldown footer", () => {
	assert.equal(
		formatFooterStatus("provider/sol", [{ targetRef: "provider/terra", remainingMs: 240_000 }]),
		"provider/sol · cooldown: provider/terra 4m",
	);
});

test("formats a cooldown-only footer", () => {
	assert.equal(
		formatFooterStatus(undefined, [{ targetRef: "provider/terra", remainingMs: 240_000 }]),
		"cooldown: provider/terra 4m",
	);
});

test("omits an empty footer", () => {
	const composedText = composeFooterStatus(undefined, undefined);
	const formattedText = formatFooterStatus(undefined, []);

	assert.equal(composedText, undefined);
	assert.equal(formattedText, undefined);
});

test("omits cooldown status when no targets are cooling", () => {
	assert.equal(formatCooldownStatus([]), undefined);
});

test("formats one cooling target", () => {
	assert.equal(
		formatCooldownStatus([
			{
				targetRef: "amazon-bedrock/global.anthropic.model-premium",
				remainingMs: 28_000,
			},
		]),
		"cooldown: amazon-bedrock/global.anthropic.model-premium 28s",
	);
});

test("formats cooling targets in declared order", () => {
	assert.equal(
		formatCooldownStatus([
			{
				targetRef: "amazon-bedrock/global.anthropic.model-premium",
				remainingMs: 28_000,
			},
			{
				targetRef: "amazon-bedrock/global.anthropic.claude-opus-5",
				remainingMs: 240_000,
			},
		]),
		"cooldown: amazon-bedrock/global.anthropic.model-premium 28s, amazon-bedrock/global.anthropic.claude-opus-5 4m",
	);
});

test("formats a failover warning with the next target", () => {
	assert.equal(
		formatFailoverWarning({
			role: "fable-opus-fallback",
			failedTarget: "amazon-bedrock/global.anthropic.model-premium",
			reason: "throttled",
			nextTarget: "amazon-bedrock/global.anthropic.claude-opus-5",
			cooldownMs: 30_000,
			failCount: 1,
		}),
		'alias "fable-opus-fallback": amazon-bedrock/global.anthropic.model-premium failed (throttled); falling back to amazon-bedrock/global.anthropic.claude-opus-5 — cooldown 30s (failure 1)',
	);
});

test("formats a failover warning with missing persisted fields", () => {
	assert.equal(
		formatFailoverWarning({}),
		'alias "unknown": unknown failed (); chain exhausted — cooldown 0s (failure 0)',
	);
});

test("formats a failover warning when the chain is exhausted", () => {
	assert.equal(
		formatFailoverWarning({
			role: "fable-opus-fallback",
			failedTarget: "amazon-bedrock/global.anthropic.claude-opus-5",
			reason: "unavailable",
			cooldownMs: 120_000,
			failCount: 2,
		}),
		'alias "fable-opus-fallback": amazon-bedrock/global.anthropic.claude-opus-5 failed (unavailable); chain exhausted — cooldown 2m (failure 2)',
	);
});

test("formats durations in seconds below one minute", () => {
	assert.equal(formatDuration(30_000), "30s");
});

test("formats values that round to sixty seconds in minutes", () => {
	assert.equal(formatDuration(59_999), "1m");
});

test("defaults invalid or missing durations to zero seconds", () => {
	assert.equal(formatDuration(Number.NaN), "0s");
	assert.equal(formatDuration(undefined), "0s");
});

test("formats durations in minutes from one minute", () => {
	assert.equal(formatDuration(120_000), "2m");
});

test("an account failure tells the user a new login brings the provider back", () => {
	const text = formatFailoverWarning({
		role: "r",
		failedTarget: "acct/a",
		reason: "No API key for provider: acct",
		nextTarget: "other/m",
		cooldownMs: 3_600_000,
		failCount: 1,
		failureClass: "account",
	});
	assert.match(text, /acct\/\* skipped until a new login or the cooldown ends$/);
});

test("other failures keep the existing wording", () => {
	const text = formatFailoverWarning({ role: "r", failedTarget: "acct/a", reason: "x", nextTarget: "other/m", cooldownMs: 1, failCount: 1, failureClass: "transient" });
	assert.doesNotMatch(text, /new login/);
});
