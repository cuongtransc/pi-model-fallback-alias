import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_COOLDOWN_POLICY, createCooldownRegistry } from "../src/fallback/index.ts";

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
