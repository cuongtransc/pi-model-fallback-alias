import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_COOLDOWN_POLICY, BUILT_IN_COOLDOWN_POLICY, createCooldownRegistry, providerCooldownKey, runFallbackChain, type TimerApi } from "../src/fallback/index.ts";

test("in-memory registry stores the credential and clears an entry", () => {
	const cooldowns = createCooldownRegistry(() => 0);
	cooldowns.recordFailure("acct/*", ACCOUNT_COOLDOWN_POLICY, "aaaaaaaaaaaaaaaa");
	assert.equal(cooldowns.state("acct/*")!.credential, "aaaaaaaaaaaaaaaa");
	cooldowns.recordFailure("other/m");
	assert.equal(cooldowns.state("other/m")!.credential, undefined);
	assert.equal(cooldowns.clear("acct/*"), true);
	assert.equal(cooldowns.state("acct/*"), undefined);
	assert.equal(cooldowns.clear("acct/*"), false);
});

test("in-memory registry keeps the credential through success bookkeeping", () => {
	const cooldowns = createCooldownRegistry(() => 0);
	cooldowns.recordFailure("acct/*", ACCOUNT_COOLDOWN_POLICY, "aaaaaaaaaaaaaaaa");
	cooldowns.recordSuccess("acct/*", 2);
	assert.equal(cooldowns.state("acct/*")!.credential, "aaaaaaaaaaaaaaaa");
	cooldowns.resetSuccesses("acct/*");
	assert.deepEqual(cooldowns.state("acct/*"), {
		failCount: 1,
		nextRetryAt: ACCOUNT_COOLDOWN_POLICY.baseMs,
		credential: "aaaaaaaaaaaaaaaa",
	});
});

type FakeEvent = { type: "text_start" } | { type: "done"; message?: string };
async function* events(): AsyncGenerator<FakeEvent> {
	yield { type: "text_start" };
	yield { type: "done", message: "ok" };
}
async function* throwBeforeEvent(reason: string): AsyncGenerator<FakeEvent> {
	throw new Error(reason);
}
const DEAD = 'Model alias "r" target "acct/a" is unavailable: OpenAI Codex token refresh failed (401): {}';

function chain(cooldowns: ReturnType<typeof createCooldownRegistry>, credential: { value: string }, opened: string[], dead: () => boolean) {
	return runFallbackChain<FakeEvent>({
		role: "r",
		targets: ["acct/a", "acct/b", "other/m"],
		cooldowns,
		credentialOf: (target) => (target.startsWith("acct/") ? credential.value : "cccccccccccccccc"),
		open: async (target) => {
			opened.push(target);
			return target.startsWith("acct/") && dead() ? throwBeforeEvent(DEAD) : events();
		},
		forward: () => undefined,
		warn: () => undefined,
	});
}

test("an account failure cools the provider, skips its siblings and stores the fingerprint", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const opened: string[] = [];
	await chain(cooldowns, { value: "aaaaaaaaaaaaaaaa" }, opened, () => true);
	assert.deepEqual(opened, ["acct/a", "other/m"]);
	assert.equal(cooldowns.state(providerCooldownKey("acct/a"))!.credential, "aaaaaaaaaaaaaaaa");
	assert.equal(cooldowns.state("acct/*")!.nextRetryAt, 3_600_000);
});

test("an unchanged credential keeps the provider skipped", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const credential = { value: "aaaaaaaaaaaaaaaa" };
	await chain(cooldowns, credential, [], () => true);
	const opened: string[] = [];
	await chain(cooldowns, credential, opened, () => true);
	assert.deepEqual(opened, ["other/m"]);
});

test("a new login clears the cooldown and the provider serves the next request", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const credential = { value: "aaaaaaaaaaaaaaaa" };
	let dead = true;
	await chain(cooldowns, credential, [], () => dead);
	credential.value = "bbbbbbbbbbbbbbbb";
	dead = false;
	const opened: string[] = [];
	await chain(cooldowns, credential, opened, () => dead);
	assert.deepEqual(opened, ["acct/a"]);
	assert.equal(cooldowns.state("acct/*"), undefined);
});

test("a bare 401 status makes an account failure", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	await runFallbackChain<FakeEvent>({
		role: "r",
		targets: ["acct/a", "other/m"],
		cooldowns,
		credentialOf: () => "aaaaaaaaaaaaaaaa",
		failureStatus: (target) => (target === "acct/a" ? 401 : undefined),
		open: async (target) => (target === "acct/a" ? throwBeforeEvent("request failed") : events()),
		forward: () => undefined,
		warn: () => undefined,
	});
	assert.equal(cooldowns.state("acct/*")!.credential, "aaaaaaaaaaaaaaaa");
	assert.equal(cooldowns.state("acct/a"), undefined);
});

test("single-target account failure stores the fingerprint", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	await assert.rejects(
		runFallbackChain<FakeEvent>({
			role: "r",
			targets: ["acct/a"],
			cooldowns,
			credentialOf: () => "aaaaaaaaaaaaaaaa",
			open: async () => throwBeforeEvent(DEAD),
			forward: () => undefined,
			warn: () => undefined,
		}),
	);
	assert.equal(cooldowns.state("acct/*")!.credential, "aaaaaaaaaaaaaaaa");
});

test("an entry without credential is never cleared by a check", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	cooldowns.recordFailure("acct/*");
	await chain(cooldowns, { value: "bbbbbbbbbbbbbbbb" }, [], () => false);
	assert.notEqual(cooldowns.state("acct/*"), undefined);
});

test("a bare status classifies once and drives the sibling skip", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const opened: string[] = [];
	const calls: string[] = [];
	await runFallbackChain<FakeEvent>({
		role: "r",
		targets: ["acct/a", "acct/b", "other/m"],
		cooldowns,
		credentialOf: () => "aaaaaaaaaaaaaaaa",
		failureStatus: (target) => {
			calls.push(target);
			return target === "acct/a" ? 401 : undefined;
		},
		open: async (target) => {
			opened.push(target);
			return target === "acct/a" ? throwBeforeEvent("request failed") : events();
		},
		forward: () => undefined,
		warn: () => undefined,
	});
	assert.deepEqual(opened, ["acct/a", "other/m"]);
	assert.deepEqual(calls, ["acct/a"]);
});

test("a timeout stays per-target even when a stale 401 is recorded", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const classes: unknown[] = [];
	const callbacks: Array<() => void> = [];
	const timers: TimerApi = {
		setTimeout(callback) {
			callbacks.push(callback);
			return {};
		},
		clearTimeout() {},
	};
	const run = runFallbackChain<FakeEvent>({
		role: "r",
		targets: ["acct/a", "other/m"],
		cooldowns,
		timers,
		policy: { timeouts: { firstEventMs: 10 }, cooldown: BUILT_IN_COOLDOWN_POLICY },
		credentialOf: () => "aaaaaaaaaaaaaaaa",
		failureStatus: () => 401,
		open: async (target) => (target === "acct/a" ? hang() : events()),
		forward: () => undefined,
		warn: (_target, _reason, _next, _cooldown, failureClass) => classes.push(failureClass),
	});
	await new Promise((resolve) => setImmediate(resolve));
	for (const callback of callbacks) callback();
	await run;
	assert.equal(cooldowns.state("acct/*"), undefined);
	assert.notEqual(cooldowns.state("acct/a"), undefined);
	assert.deepEqual(classes, ["transient"]);
});

async function* hang(): AsyncGenerator<FakeEvent> {
	await new Promise<void>(() => undefined);
}

test("a credential that reads as none never clears an account cooldown", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const credential = { value: "aaaaaaaaaaaaaaaa" };
	await chain(cooldowns, credential, [], () => true);
	credential.value = "none";
	const opened: string[] = [];
	await chain(cooldowns, credential, opened, () => true);
	assert.deepEqual(opened, ["other/m"]);
	assert.equal(cooldowns.state("acct/*")!.credential, "aaaaaaaaaaaaaaaa");
});

test("in-memory clear with an expected credential deletes only that credential's entry", () => {
	const cooldowns = createCooldownRegistry(() => 0);
	cooldowns.recordFailure("acct/*", ACCOUNT_COOLDOWN_POLICY, "bbbbbbbbbbbbbbbb");
	assert.equal(cooldowns.clear("acct/*", "aaaaaaaaaaaaaaaa"), false);
	assert.equal(cooldowns.state("acct/*")!.credential, "bbbbbbbbbbbbbbbb");
	assert.equal(cooldowns.clear("acct/*", "bbbbbbbbbbbbbbbb"), true);
	assert.equal(cooldowns.state("acct/*"), undefined);
});

test("the credential check clears with the stale credential it read", async () => {
	const inner = createCooldownRegistry(() => 0);
	const clears: unknown[][] = [];
	const cooldowns = { ...inner, clear: (...args: Parameters<typeof inner.clear>) => (clears.push(args), inner.clear(...args)) };
	const credential = { value: "aaaaaaaaaaaaaaaa" };
	await chain(cooldowns, credential, [], () => true);
	credential.value = "bbbbbbbbbbbbbbbb";
	await chain(cooldowns, credential, [], () => false);
	assert.deepEqual(clears, [["acct/*", "aaaaaaaaaaaaaaaa"]]);
});
