# Self-Healing Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An alias steps over a provider whose account is dead and uses it again on the first request after a new login, with no config edit and no reset command.

**Architecture:** A pure `classifyFailure` sorts each failure into `quota`, `account` or `transient`. An `account` failure cools the whole provider (`<provider>/*`) and stores a fingerprint of the provider's credential in the cooldown entry; at the start of every chain run, an entry whose stored fingerprint differs from the current one is cleared. The fingerprint is a hash of the provider's `auth.json` entry (minus rotating fields) and its `models.json` `apiKey` text.

**Tech Stack:** TypeScript on Node ≥ 22.19, `node:test` + `node:assert/strict`, c8 coverage gate, pi extension API (`@earendil-works/pi-coding-agent`).

**Spec:** `docs/superpowers/specs/2026-10-22-self-healing-accounts-design.md`

## Global Constraints

- Run every gate with `npm run check` (coverage ≥ 95 % statements/lines/functions/branches on `index.ts` and `src/**/*.ts`, typecheck, pack check). Never add a coverage exclusion.
- Tests: `node:test` `test(...)` + `assert` from `node:assert/strict`, files `__tests__/<name>.test.ts`; tabs for indentation, as the existing files.
- Commits: Release Please Conventional Commits (`feat(scope): …`, `fix(scope): …`, `docs: …`, `test: …`); no AI attribution lines.
- Target refs in tests stay provider-neutral (`acct/a`, `other/m`); real failure reasons may be quoted verbatim as the existing quota tests do.
- `FailureClass` is the string union `"quota" | "account" | "transient"`, defined once in `src/fallback/cooldown.ts`.
- `ACCOUNT_COOLDOWN_POLICY` = `{ baseMs: 3_600_000, capMs: 21_600_000, resetSuccesses: 1 }` (same numbers as `QUOTA_COOLDOWN_POLICY`).
- A credential fingerprint is 16 lowercase hex characters, or the literal `"none"` when the provider has neither an `auth.json` entry nor a `models.json` `apiKey`. Credential values are never logged, returned or stored; only the fingerprint is.
- The debug-log event for a cleared entry is `cooldown-clear` with fields `{ targetRef }`.

## Review Focus

- A provider whose fingerprint cannot be computed (unreadable `auth.json`, corrupt JSON) must not lose or clear its cooldown on every request: `credentialOf` then reads the file as absent, which yields a stable value → Task 4 test "corrupt files read as absent".
- An `account` failure on a single-target alias (the `forwardSingleTarget` path) must store the fingerprint too → Task 3 test "single-target account failure stores the fingerprint".
- A 5xx or 429 whose JSON body contains `401` must stay `transient` → Task 1 test "5xx and 429 never classify as account".
- A token refresh (new `access`/`expires`) must not clear an account cooldown, or a dead Codex login retries on every refresh → Task 4 test "rotating fields do not change the fingerprint".
- State files written before this change (entries without `credential`) must load and never be cleared by the credential check → Task 2 test "an entry without credential is never cleared by a check".

---

### Task 1: Failure classes

**Files:**
- Modify: `src/fallback/cooldown.ts` (beside `QUOTA_EXHAUSTED` / `isQuotaExhausted`)
- Modify: `src/fallback/index.ts` (export the new names)
- Test: `__tests__/failure-class.test.ts` (create)

**Interfaces:**
- Produces: `export type FailureClass = "quota" | "account" | "transient"`; `export function classifyFailure(reason: string, httpStatus?: number): FailureClass`; `export const ACCOUNT_COOLDOWN_POLICY: CooldownPolicy`. `isQuotaExhausted(reason)` stays and becomes `classifyFailure(reason) === "quota"`.

- [ ] **Step 1: Write the failing test**

```ts
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
});

test("quota text wins over an account status", () => {
	assert.equal(classifyFailure(QUOTA[0]!, 401), "quota");
});

test("account cooldown backs off from one hour to six", () => {
	assert.deepEqual(ACCOUNT_COOLDOWN_POLICY, { baseMs: 3_600_000, capMs: 21_600_000, resetSuccesses: 1 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import ./scripts/pi-resolve.mjs --test __tests__/failure-class.test.ts`
Expected: FAIL — `classifyFailure` is not exported.

- [ ] **Step 3: Implement `classifyFailure(reason: string, httpStatus?: number): FailureClass` in `src/fallback/cooldown.ts`**

Order of checks: (1) quota regex `/usage[ _]?limit|insufficient account funds|credit balance is too low|run out of credits/i` → `quota`; (2) `httpStatus === 429 || httpStatus >= 500`, or the part of `reason` before its first `{` matches `/\b(5\d\d|429)\b|temporarily unavailable|rate limited/i` → `transient`; (3) `httpStatus === 401`, or `reason` matches `/is unavailable: |invalidated oauth token|invalid_grant|no api key/i` → `account`; (4) otherwise `transient`. Export `FailureClass`, `classifyFailure`, `ACCOUNT_COOLDOWN_POLICY` from `src/fallback/index.ts`.

- [ ] **Step 4: Run the test and the existing quota tests**

Run: `node --import ./scripts/pi-resolve.mjs --test __tests__/failure-class.test.ts __tests__/quota-cooldown.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/fallback/cooldown.ts src/fallback/index.ts __tests__/failure-class.test.ts
git commit -m "feat(cooldown): classify failures as quota, account or transient"
```

### Task 2: Cooldown entries carry a credential and can be cleared

**Files:**
- Modify: `src/fallback/types.ts` (`CooldownState`, `CooldownRegistry`)
- Modify: `src/fallback/cooldown.ts` (`createCooldownRegistry`)
- Modify: `src/cooldown-store.ts` (`createSharedCooldownRegistry`)
- Test: `__tests__/cooldown-store.test.ts` (add tests), `__tests__/account-cooldown.test.ts` (create; in-memory registry)

**Interfaces:**
- Produces: `CooldownState.credential?: string`; `CooldownRegistry.recordFailure(target: string, cooldown?: CooldownPolicy, credential?: string): CooldownUpdate` — stores `credential` when given, otherwise the entry has none; `CooldownRegistry.clear(target: string): boolean` — deletes the entry, returns whether one existed. The shared store's `clear` reloads, writes atomically like `recordFailure`, and logs `cooldown-clear` `{ targetRef }` only when an entry was removed.

- [ ] **Step 1: Write the failing tests**

In `__tests__/account-cooldown.test.ts`:

```ts
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
```

In `__tests__/cooldown-store.test.ts` (reuse its `FakeCooldownFs`, `STATE_PATH` and the registry construction the file's other tests use):

```ts
test("persists the credential and clears an entry for other processes", () => {
	const fs = new FakeCooldownFs();
	const logged: Array<[string, unknown]> = [];
	const debugLog = { log: (event: string, data: unknown) => logged.push([event, data]) } as never;
	const first = createSharedCooldownRegistry({ dir: "/fake/logs", fs, now: () => 0, debugLog });
	first.recordFailure("acct/*", undefined, "aaaaaaaaaaaaaaaa");
	const second = createSharedCooldownRegistry({ dir: "/fake/logs", fs, now: () => 0 });
	assert.equal(second.state("acct/*")!.credential, "aaaaaaaaaaaaaaaa");
	assert.equal(second.clear("acct/*"), true);
	assert.equal(first.state("acct/*"), undefined);
	assert.equal(first.clear("acct/*"), false);
	assert.equal(logged.filter(([event]) => event === "cooldown-clear").length, 0); // second had no log
	first.recordFailure("acct/*", undefined, "b");
	first.clear("acct/*");
	assert.deepEqual(logged.at(-1), ["cooldown-clear", { targetRef: "acct/*" }]);
});

test("a state file written before credentials existed still loads", () => {
	const fs = new FakeCooldownFs();
	fs.files.set(STATE_PATH, JSON.stringify({ "acct/*": { failCount: 1, nextRetryAt: 10 } }));
	fs.mtimes.set(STATE_PATH, 1);
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", fs, now: () => 0 });
	assert.deepEqual(registry.state("acct/*"), { failCount: 1, nextRetryAt: 10 });
});
```

If the file builds its registries with a helper, use that helper with the same arguments instead of the literal constructor calls.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./scripts/pi-resolve.mjs --test __tests__/account-cooldown.test.ts __tests__/cooldown-store.test.ts`
Expected: FAIL — `clear` is not a function / `credential` undefined.

- [ ] **Step 3: Implement** the `recordFailure` third parameter and `clear(target)` in both registries; `recordSuccess`/`resetSuccesses` keep an existing `credential` when they rewrite an entry.

- [ ] **Step 4: Run the tests and the gate**

Run: `npm run check`
Expected: pass, coverage ≥ 95 %.

- [ ] **Step 5: Commit**

```bash
git add src/fallback/types.ts src/fallback/cooldown.ts src/cooldown-store.ts __tests__/account-cooldown.test.ts __tests__/cooldown-store.test.ts
git commit -m "feat(cooldown): store a credential fingerprint and clear single entries"
```

### Task 3: The chain cools a dead account by provider and recovers on a new credential

**Files:**
- Modify: `src/fallback/types.ts` (`FallbackOptions`)
- Modify: `src/fallback/chain.ts` (`runFallbackChain`, `forwardSingleTarget`, `warnCooldown`)
- Test: `__tests__/account-cooldown.test.ts` (add)

**Interfaces:**
- Consumes: `classifyFailure`, `ACCOUNT_COOLDOWN_POLICY` (Task 1); `recordFailure(target, cooldown, credential)`, `clear(target)`, `CooldownState.credential` (Task 2).
- Produces: `FallbackOptions.credentialOf?(target: string): string | undefined` — fingerprint of the target's provider; `FallbackOptions.failureStatus?(target: string): number | undefined` — HTTP status of the target's last failed response.

- [ ] **Step 1: Write the failing tests** (append to `__tests__/account-cooldown.test.ts`)

```ts
import { providerCooldownKey, runFallbackChain } from "../src/fallback/index.ts";

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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./scripts/pi-resolve.mjs --test __tests__/account-cooldown.test.ts`
Expected: FAIL — the dead provider is tried twice and no credential is stored.

- [ ] **Step 3: Implement** in `src/fallback/chain.ts`:
  - at the top of `runFallbackChain` (before the single-target branch), for each distinct `providerCooldownKey` of `options.targets`: if `cooldowns.state(key)?.credential` is defined and `options.credentialOf` returns a defined value different from it for that provider's first target, call `cooldowns.clear(key)`;
  - in `warnCooldown`, `classifyFailure(reason, options.failureStatus?.(target))`: `quota` as today; `account` → `recordFailure(providerCooldownKey(target), ACCOUNT_COOLDOWN_POLICY, options.credentialOf?.(target))`; `transient` → per-target as today;
  - the later-same-provider skip applies to `quota` and `account` (replace the `isQuotaExhausted` test with `classifyFailure(...) !== "transient"`, using the same status).

- [ ] **Step 4: Run the tests and the gate**

Run: `npm run check`
Expected: pass, coverage ≥ 95 %.

- [ ] **Step 5: Commit**

```bash
git add src/fallback/types.ts src/fallback/chain.ts __tests__/account-cooldown.test.ts
git commit -m "feat(fallback): cool a dead account by provider and resume on a new credential"
```

### Task 4: Credential fingerprint

**Files:**
- Create: `src/stream/credential-fingerprint.ts`
- Test: `__tests__/credential-fingerprint.test.ts` (create)

**Interfaces:**
- Produces: `export function credentialFingerprint(provider: string, agentDir: string, readFile?: (path: string) => string): string` — reads `<agentDir>/auth.json` (entry `[provider]`, with keys `access` and `expires` removed) and `<agentDir>/models.json` (`providers[provider].apiKey`); returns `"none"` when both are absent, else the first 16 hex chars of `sha256` over `JSON.stringify({ auth, apiKey })` with object keys sorted recursively. An unreadable or non-JSON file counts as absent. `readFile` defaults to `(path) => readFileSync(path, "utf8")`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { credentialFingerprint } from "../src/stream/credential-fingerprint.ts";

function files(auth: unknown, models: unknown): (path: string) => string {
	return (path) => {
		const value = path.endsWith("/auth.json") ? auth : path.endsWith("/models.json") ? models : undefined;
		if (value === undefined) throw new Error("ENOENT");
		return typeof value === "string" ? value : JSON.stringify(value);
	};
}
const OAUTH = { type: "oauth", refresh: "r1", access: "a1", expires: 1, accountId: "u1" };

test("no auth entry and no apiKey is none", () => {
	assert.equal(credentialFingerprint("acct", "/agent", files({}, { providers: {} })), "none");
	assert.equal(credentialFingerprint("acct", "/agent", files(undefined, undefined)), "none");
});

test("a login gives a 16-hex fingerprint", () => {
	assert.match(credentialFingerprint("acct", "/agent", files({ acct: OAUTH }, undefined)), /^[0-9a-f]{16}$/);
});

test("rotating fields do not change the fingerprint", () => {
	const before = credentialFingerprint("acct", "/agent", files({ acct: OAUTH }, undefined));
	const refreshed = { ...OAUTH, access: "a2", expires: 2 };
	assert.equal(credentialFingerprint("acct", "/agent", files({ acct: refreshed }, undefined)), before);
});

test("a new login or a new key changes it", () => {
	const before = credentialFingerprint("acct", "/agent", files({ acct: OAUTH }, undefined));
	assert.notEqual(credentialFingerprint("acct", "/agent", files({ acct: { ...OAUTH, refresh: "r2" } }, undefined)), before);
	const keyA = credentialFingerprint("acct", "/agent", files({}, { providers: { acct: { apiKey: "!cmd a" } } }));
	const keyB = credentialFingerprint("acct", "/agent", files({}, { providers: { acct: { apiKey: "!cmd b" } } }));
	assert.notEqual(keyA, keyB);
});

test("key order does not change it", () => {
	const reordered = { accountId: "u1", expires: 1, access: "a1", refresh: "r1", type: "oauth" };
	assert.equal(
		credentialFingerprint("acct", "/agent", files({ acct: reordered }, undefined)),
		credentialFingerprint("acct", "/agent", files({ acct: OAUTH }, undefined)),
	);
});

test("corrupt files read as absent", () => {
	assert.equal(credentialFingerprint("acct", "/agent", files("{not json", "[")), "none");
});

test("the fingerprint never contains a credential value", () => {
	const value = credentialFingerprint("acct", "/agent", files({ acct: OAUTH }, undefined));
	for (const secret of ["r1", "a1", "u1"]) assert.equal(value.includes(secret), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import ./scripts/pi-resolve.mjs --test __tests__/credential-fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `credentialFingerprint`** with `node:crypto` `createHash("sha256")`.

- [ ] **Step 4: Run the tests and the gate**

Run: `npm run check`
Expected: pass, coverage ≥ 95 %.

- [ ] **Step 5: Commit**

```bash
git add src/stream/credential-fingerprint.ts __tests__/credential-fingerprint.test.ts
git commit -m "feat(stream): fingerprint a provider's credential without reading the network"
```

### Task 5: Wire it into the alias stream, the warning and the README

**Files:**
- Modify: `src/stream/alias-stream.ts` (`AliasStreamDependencies`, the `runFallbackChain` call, the `warn` → `onFailover` data)
- Modify: `index.ts` (pass `agentDir: getAgentDir()` to `createAliasStreams`)
- Modify: `src/fallback/types.ts` (`FailoverEntryData.failureClass?: FailureClass`)
- Modify: `src/status/status.ts` (`formatFailoverWarning`)
- Modify: `README.md` (Behavior section)
- Test: `__tests__/status.test.ts` (add), `__tests__/alias-stream.test.ts` (add)

**Interfaces:**
- Consumes: `credentialFingerprint` (Task 4); `FallbackOptions.credentialOf`, `FallbackOptions.failureStatus` (Task 3); `classifyFailure` (Task 1).
- Produces: `AliasStreamDependencies.agentDir: string`. In the chain call: `credentialOf: (target) => credentialFingerprint(target.slice(0, target.indexOf("/")), agentDir)`; `failureStatus: (target) => metadataByTarget.get(target)?.httpStatus`. `onFailover` data gains `failureClass: classifyFailure(reason, metadataByTarget.get(failedTarget)?.httpStatus)`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/status.test.ts`:

```ts
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
```

In `__tests__/alias-stream.test.ts`, extend the file's `AliasStreamTestOptions` and `aliasStream` helper with five optional fields, each defaulting to today's behaviour: `targetRefs?: string[]` (replaces the generated `target/<model>` list in `aliases`), `agentDir?: string` (passed as `agentDir`, default `"/nonexistent"`), `cooldowns?: CooldownRegistry` (default `createCooldownRegistry()`), `onFailover?(data: FailoverEntryData): void`, and `auth?(model: Model<Api>): { ok: boolean; error?: string }` (used by `getApiKeyAndHeaders`, default `{ ok: true }`). Then add (imports: `mkdtempSync`, `writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, `type FailoverEntryData` from `../src/fallback/index.ts`):

```ts
test("a target without credentials is skipped until a login, then serves first", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "alias-"));
	writeFileSync(join(agentDir, "auth.json"), "{}");
	const cooldowns = createCooldownRegistry();
	const failovers: FailoverEntryData[] = [];
	const selected: string[] = [];
	let loggedIn = false;
	const run = () =>
		collect(
			aliasStream(
				{
					"dead-model": asyncEvents(doneEvent(targetMessage({ model: "dead-model" }))),
					"live-model": asyncEvents(doneEvent(targetMessage({ model: "live-model" }))),
				},
				{
					targetRefs: ["acct/dead-model", "other/live-model"],
					agentDir,
					cooldowns,
					onFailover: (data) => failovers.push(data),
					onTargetSelected: (_role, targetRef) => selected.push(targetRef),
					auth: (model) =>
						model.id === "dead-model" && !loggedIn ? { ok: false, error: "No API key for provider: acct" } : { ok: true },
				},
			).stream,
		);

	await run();
	assert.deepEqual(selected, ["other/live-model"]);
	assert.equal(cooldowns.state("acct/*")!.credential, "none");
	assert.equal(failovers[0]!.failureClass, "account");

	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ acct: { type: "api_key", key: "k" } }));
	loggedIn = true;
	selected.length = 0;
	await run();
	assert.deepEqual(selected, ["acct/dead-model"]);
	assert.equal(cooldowns.state("acct/*"), undefined);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./scripts/pi-resolve.mjs --test __tests__/status.test.ts __tests__/alias-stream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**: `formatFailoverWarning` accepts `failureClass?: FailureClass` and, for `"account"`, appends `; <provider>/* skipped until a new login or the cooldown ends` (provider = text before the first `/` of `failedTarget`); the wiring as listed under Interfaces. README Behavior: one bullet after the quota bullet — an account failure (missing key, rejected OAuth refresh, HTTP 401, `invalid_grant`) cools `<provider>/*` for 1 h doubling to 6 h, skips the provider's other targets, and is cleared on the first request after `/login` changes the provider's credential (fingerprint of its `auth.json` entry without `access`/`expires`, and its `models.json` `apiKey` text); a key a `!command` decrypts from a replaced file is picked up when the backoff ends or by `/model-alias-reset-cooldown`.

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: pass, coverage ≥ 95 %.

- [ ] **Step 5: Commit**

```bash
git add src/stream/alias-stream.ts index.ts src/fallback/types.ts src/status/status.ts README.md __tests__/status.test.ts __tests__/alias-stream.test.ts
git commit -m "feat: skip a dead account until a new login and say so in the warning"
```

### Task 6: Replay the real corpus and one real run

**Files:** none committed (scripts and logs go to a scratch directory outside the repo).

- [ ] **Step 1: Replay the classifier over every debug log on disk**

Write a scratch `replay.mts` that imports `classifyFailure` from `src/fallback/cooldown.ts` and, for every line of `~/.pi/agent/state/pi-model-fallback-alias/pi-model-alias-debug.jsonl*` and `~/.local/share/cta/remote/*/pi-agent/state/pi-model-fallback-alias/pi-model-alias-debug.jsonl*`, classifies `reason` with `httpStatus`. Run it with `node --import ./scripts/pi-resolve.mjs <scratch>/replay.mts`.
Expected: class counts printed; zero `account` reasons matching `/\b(5\d\d|429)\b|temporarily unavailable/` before the first `{`; every reason containing `is unavailable: ` classified `account`. The spec's replay (57 files) gave quota 128, account 79, transient 545; a difference is explained in the report.

- [ ] **Step 2: Real run against real providers**

In a scratch agent dir: copy `~/.pi/agent/models.json` and `~/.pi/agent/auth.json`, delete the `openai-codex` entry from the copy's `auth.json`, write an alias map `{"probe":["openai-codex/gpt-6-luna","xai/grok-4.3"]}`. With `PI_CODING_AGENT_DIR=<scratch> PI_MODEL_ALIAS_MAP=<scratch>/map.json PI_MODEL_ALIAS_STATE_DIR=<scratch>/state`, run `pi -p --no-session -nt -ns -nc -ne -e <worktree>/index.ts --model alias/probe "Reply with exactly: OK" < /dev/null`.
Expected: `OK`; `<scratch>/state/cooldown-state.json` holds `openai-codex/*` with `credential` `"none"`. Copy the real `openai-codex` entry back into the scratch `auth.json`, run the same command again.
Expected: `OK`, the debug log's last `open-attempt` with `ok: true` is `openai-codex/gpt-6-luna`, and `openai-codex/*` is gone from the state file.

- [ ] **Step 3: Report** both results (counts, the two state files) in the PR description.
