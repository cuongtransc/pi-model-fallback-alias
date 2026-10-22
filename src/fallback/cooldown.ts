import { execFileSync } from "node:child_process";
import type { CooldownPolicy, CooldownRegistry, CooldownState, CooldownUpdate } from "./types.ts";

export const COOLDOWN_BASE_MS = 5 * 60_000;
export const COOLDOWN_CAP_MS = 60 * 60_000;
export const DEFAULT_STATUS_REFRESH_MS = 2_000;
export const MAX_STATUS_REFRESH_MS = 60_000;

/** Policy used when a config supplies no cooldown fields. */
export const BUILT_IN_COOLDOWN_POLICY: CooldownPolicy = {
	baseMs: COOLDOWN_BASE_MS,
	capMs: COOLDOWN_CAP_MS,
	resetSuccesses: 1,
};

/**
 * Cooldown for an account-wide quota: one failure means every model of that
 * provider is out until the quota window resets, which is hours or days away.
 */
export const QUOTA_COOLDOWN_POLICY: CooldownPolicy = {
	baseMs: 60 * 60_000,
	capMs: 6 * 60 * 60_000,
	resetSuccesses: 1,
};

/** Cooldown for a dead account (expired login, missing key): same horizon as a quota. */
export const ACCOUNT_COOLDOWN_POLICY: CooldownPolicy = {
	baseMs: 60 * 60_000,
	capMs: 6 * 60 * 60_000,
	resetSuccesses: 1,
};

export type FailureClass = "quota" | "account" | "transient";

// "usage limit" covers OpenCode Go's GoUsageLimitError ("Go usage limit exceeded");
// "insufficient account funds" is OpenCode's 402 once paid credits are spent too;
// "credit balance is too low" is Anthropic's 400 for an empty prepaid balance;
// "run out of credits" is xAI's 403 without credits or a Grok subscription;
// a plain "[429] Request rate limited" is transient and stays per target.
const QUOTA_EXHAUSTED =
	/usage[ _]?limit|insufficient account funds|credit balance is too low|run out of credits/i;
const TRANSIENT_STATUS = /\b(5\d\d|429)\b/;
const TRANSIENT_TEXT = /temporarily unavailable|rate limited/i;
// A token refresh that never reached a verdict: offline (undici "fetch failed", errno codes),
// the 15 s refresh timeout or an aborted refresh, or another pi process holding auth.json's lock.
// pi reports these inside "is unavailable: …", yet the credential may be fine.
const REFRESH_INTERRUPTED = new RegExp(
	[
		"fetch failed",
		"the operation was aborted due to timeout",
		"token refresh aborted",
		"login cancelled",
		"\\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ELOCKED)\\b",
		"lock file is already being held",
		"unable to update lock within the stale threshold",
		"auth storage lock was compromised",
	].join("|"),
	"i",
);
const ACCOUNT_DEAD = /is unavailable: |invalidated oauth token|invalid_grant|no api key/i;

/**
 * Quota text anywhere in the reason wins. Then transient: an HTTP status of 429 or
 * 5xx, those status digits in the reason before its first "{" (a JSON body may
 * quote an upstream status), or a transient phrase (temporarily unavailable, rate
 * limited, an interrupted token refresh) anywhere in the reason. Then a dead
 * account: HTTP 401 or account text. Anything else is transient.
 */
export function classifyFailure(reason: string, httpStatus?: number): FailureClass {
	if (QUOTA_EXHAUSTED.test(reason)) return "quota";
	const head = reason.split("{", 1)[0]!;
	const transientStatus = httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500);
	if (transientStatus || TRANSIENT_STATUS.test(head)) return "transient";
	if (TRANSIENT_TEXT.test(reason) || REFRESH_INTERRUPTED.test(reason)) return "transient";
	if (httpStatus === 401 || ACCOUNT_DEAD.test(reason)) return "account";
	return "transient";
}

export function isQuotaExhausted(reason: string): boolean {
	return classifyFailure(reason) === "quota";
}

/** stdout of `argv`, or "" when it cannot run, fails or exceeds 5 seconds. */
export function runQuotaResetCommand(argv: readonly string[]): string {
	try {
		return execFileSync(argv[0]!, argv.slice(1), {
			encoding: "utf8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return "";
	}
}

/** Cooldown key shared by every target of one provider. */
export function providerCooldownKey(target: string): string {
	return `${target.slice(0, target.indexOf("/"))}/*`;
}

export function createCooldownRegistry(now: () => number = Date.now): CooldownRegistry {
	const entries = new Map<string, CooldownState>();
	return {
		isActive(target) {
			const entry = entries.get(target);
			return entry !== undefined && entry.nextRetryAt > now();
		},
		recordFailure(target, cooldown, credential) {
			const update = nextCooldown(entries.get(target), now(), cooldown);
			entries.set(target, {
				failCount: update.failCount,
				nextRetryAt: update.nextRetryAt,
				...(credential === undefined ? {} : { credential }),
			});
			return update;
		},
		recordSuccess(target, resetAfter) {
			const entry = entries.get(target);
			if (!entry) return;
			const successCount = (entry.successCount ?? 0) + 1;
			if (successCount >= resetAfter) {
				entries.delete(target);
				return;
			}
			entries.set(target, { ...entry, successCount });
		},
		resetSuccesses(target) {
			const entry = entries.get(target);
			if (!entry || entry.successCount === undefined) return;
			const { successCount: _dropped, ...rest } = entry;
			entries.set(target, rest);
		},
		clear(target, expectedCredential) {
			if (expectedCredential !== undefined && entries.get(target)?.credential !== expectedCredential) return false;
			return entries.delete(target);
		},
		clearAll() {
			const nowMs = now();
			const clearedCount = [...entries.values()].filter((entry) => entry.nextRetryAt > nowMs).length;
			entries.clear();
			return clearedCount;
		},
		state(target) {
			const entry = entries.get(target);
			return entry ? { ...entry } : undefined;
		},
	};
}

export function nextCooldown(
	previous: CooldownState | undefined,
	now: number,
	cooldown: CooldownPolicy = BUILT_IN_COOLDOWN_POLICY,
): CooldownUpdate {
	const failCount = (previous?.failCount ?? 0) + 1;
	// Cooldown state is shared, so a shorter alias policy must never pull an
	// active retry time closer than another alias already set.
	const nextRetryAt = Math.max(previous?.nextRetryAt ?? 0, now + growthMs(failCount, cooldown));
	return { failCount, nextRetryAt, durationMs: nextRetryAt - now };
}

function growthMs(failCount: number, cooldown: CooldownPolicy): number {
	const { baseMs, capMs } = cooldown;
	// Stop doubling once the cap binds, so the exponent stays small for any valid pair.
	const exponent = Math.min(failCount - 1, Math.max(0, Math.ceil(Math.log2(capMs / baseMs))));
	return Math.min(baseMs * 2 ** exponent, capMs);
}
