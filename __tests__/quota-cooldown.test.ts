import assert from "node:assert/strict";
import test from "node:test";
import {
	createCooldownRegistry,
	isQuotaExhausted,
	providerCooldownKey,
	QUOTA_COOLDOWN_POLICY,
	runFallbackChain,
} from "../src/fallback/index.ts";
import { renderStatusTick, type AliasSession } from "../src/status/session-status.ts";

type FakeEvent = { type: "text_start" } | { type: "done"; message?: string };

const GO_QUOTA = '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}';
const HOUR_MS = 60 * 60_000;

test("recognises account-wide quota exhaustion and leaves transient rate limits alone", () => {
	assert.equal(isQuotaExhausted(GO_QUOTA), true);
	assert.equal(isQuotaExhausted("You've hit your usage limit. Try again later."), true);
	assert.equal(isQuotaExhausted("Streaming response failed: [429] Request rate limited"), false);
	assert.equal(isQuotaExhausted("latency timeout: no commit within 120000ms"), false);
	assert.equal(isQuotaExhausted("Codex error: Our servers are currently overloaded."), false);
});

test("names the provider-wide cooldown key after the target's provider", () => {
	assert.equal(providerCooldownKey("opencode-go/deepseek-v4.1-flash"), "opencode-go/*");
});

test("a quota failure cools every target of that provider and skips its siblings", async () => {
	const currentTime = 1_000;
	const cooldowns = createCooldownRegistry(() => currentTime);
	const opened: string[] = [];
	const durations: number[] = [];

	const request = () =>
		runFallbackChain<FakeEvent>({
			role: "role",
			targets: ["go/a", "go/b", "other/m"],
			cooldowns,
			open: async (target) => {
				opened.push(target);
				return target.startsWith("go/") ? throwBeforeEvent(GO_QUOTA) : events();
			},
			forward: () => undefined,
			warn: (_target, _reason, _next, cooldown) => durations.push(cooldown.durationMs),
		});

	await request();
	assert.deepEqual(opened, ["go/a", "other/m"]);
	assert.deepEqual(durations, [QUOTA_COOLDOWN_POLICY.baseMs]);
	assert.equal(cooldowns.state("go/*")!.nextRetryAt, currentTime + HOUR_MS);

	opened.length = 0;
	await request();
	assert.deepEqual(opened, ["other/m"]);
});

test("repeated quota failures back off from one hour to a six-hour cap", async () => {
	let currentTime = 0;
	const cooldowns = createCooldownRegistry(() => currentTime);
	const durations: number[] = [];

	for (let failure = 0; failure < 5; failure++) {
		await runFallbackChain<FakeEvent>({
			role: "role",
			targets: ["go/a", "other/m"],
			cooldowns,
			open: async (target) => (target === "go/a" ? throwBeforeEvent(GO_QUOTA) : events()),
			forward: () => undefined,
			warn: (_target, _reason, _next, cooldown) => durations.push(cooldown.durationMs),
		});
		currentTime = cooldowns.state("go/*")!.nextRetryAt;
	}

	assert.deepEqual(durations, [HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS, 6 * HOUR_MS, 6 * HOUR_MS]);
});

test("a transient rate limit keeps the per-target cooldown", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const opened: string[] = [];

	await runFallbackChain<FakeEvent>({
		role: "role",
		targets: ["go/a", "go/b"],
		cooldowns,
		open: async (target) => {
			opened.push(target);
			return target === "go/a" ? throwBeforeEvent("[429] Request rate limited") : events();
		},
		forward: () => undefined,
		warn: () => undefined,
	});

	assert.deepEqual(opened, ["go/a", "go/b"]);
	assert.equal(cooldowns.state("go/*"), undefined);
	assert.equal(cooldowns.state("go/a")!.failCount, 1);
});

test("the footer skips a provider in quota cooldown and lists it once", () => {
	const session = {
		registry: undefined,
		ui: { setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
		hasUI: true,
		model: { provider: "alias", id: "fast" },
		activeTargets: new Map<string, string>(),
	} as unknown as AliasSession;
	const aliases = new Map([["fast", ["go/a", "go/b", "other/m"]]]);

	const text = renderStatusTick({
		aliases,
		session,
		lastPushedText: undefined,
		now: 0,
		cooldowns: { state: (key: string) => (key === "go/*" ? { failCount: 1, nextRetryAt: 60_000 } : undefined) },
		debugLog: { log() {} },
	});

	assert.equal(text, "other/m · cooldown: go/* 1m");
});

async function* events(): AsyncGenerator<FakeEvent> {
	yield { type: "text_start" };
	yield { type: "done", message: "ok" };
}

async function* throwBeforeEvent(reason: string): AsyncGenerator<FakeEvent> {
	throw new Error(reason);
}
