# Self-healing accounts: skip a dead provider, resume on re-login

Date: 2026-10-22. Status: draft for review.

## Problem

A provider account ends (subscription lapses, credits run out, OAuth grant
revoked) while its targets stay in the alias chains. The user wants the chains
left alone: the alias should step over that provider by itself, and use it again
as soon as the account is renewed and logged in, with no edit and no reset
command.

Today failover already avoids an outage, but:

1. **Account failures cool one target at a time.** A chain with three targets
   of the dead provider fails three times whenever their cooldowns lapse.
   Only usage-limit failures (`isQuotaExhausted`) cool the whole provider.
2. **A re-login is not noticed.** The cooldown in `cooldown-state.json` runs to
   its end (up to `capMs`, 30 min in the author's config) regardless of the new
   credential, or until `/model-alias-reset-cooldown`.
3. Outside this repo, the author's `ct-doctor` fails on a chain provider without
   credentials, so a lapsed account still forces an edit (tracked separately in
   ct-dotfiles; see Out of scope).

## Evidence (real records)

Replay of every `pi-model-alias-debug.jsonl*` on three hosts (57 files, 752
failure reasons) through the proposed classifier:

| Class | Count | Real reasons |
|---|---|---|
| quota | 128 | `credit balance is too low` (85), `run out of credits or need a Grok subscription` (18), `Insufficient account funds` (14), `GoUsageLimitError` (9), `specified workspace API usage limits` (2) |
| account | 79 | `Encountered invalidated oauth token` HTTP 401 (22, the first Codex failures when the subscription ended 2026-10-17), `… is unavailable: OpenAI Codex token refresh failed (401)` (38), `xAI OAuth token refresh failed (HTTP 400): invalid_grant` (6), `No API key for provider` (5), `Failed to resolve API key … from shell command` (8) |
| transient | 545 | timeouts, 429 rate limits, 5xx — including `xai 503 Authentication is temporarily unavailable`, which must stay transient |

After the Codex subscription ended, the debug logs hold 26 failed Codex attempts
(10-17: 21, 10-18: 2, 10-19: 3): the cost today is small; the gain is no edit and
immediate recovery.

## Design

### 1. Failure classes

`src/fallback/cooldown.ts` classifies a failure reason into one of three classes
(the existing `isQuotaExhausted` becomes the `quota` branch):

- **quota** — the account's allowance is spent until a reset. Patterns: today's
  `usage[ _]?limit|insufficient account funds`, plus `credit balance is too low`
  and `run out of credits`. Behaviour unchanged: provider-wide cooldown
  `<provider>/*` until the `quotaResetCommand` time, else 1 h doubling to 6 h.
- **account** (new) — the credential is missing or no longer accepted:
  - the target-auth gate's `is unavailable:` error (no API key, OAuth refresh
    rejected, key command failed), and
  - a provider answer with HTTP status 401, or a reason matching
    `invalidated oauth token|invalid_grant|No API key`.

  A reason whose status is 5xx or 429, or that says `temporarily unavailable`,
  is never `account`. 403 alone is not `account` (an edge or WAF can send it);
  the 403s seen so far carry quota text and land in `quota`.
- **transient** — everything else; per-target cooldown as today.

### 2. Account cooldown, keyed to the credential

An `account` failure:

- cools the provider key `<provider>/*` with `ACCOUNT_COOLDOWN_POLICY`
  (1 h doubling to 6 h, like quota), and skips the provider's later targets in
  the same request (the existing `withoutLaterSameProvider`);
- stores the provider's **credential fingerprint** in the entry:
  `CooldownState.credential?: string` (optional, so existing state files load).

Before each request the alias stream compares, for every provider key in the
chain whose entry has a `credential`, the stored fingerprint with the current
one; a difference deletes the entry (`CooldownRegistry.clear(key)`, logged as
`cooldown-cleared` with reason `credential-changed`). The re-logged-in provider
is therefore tried on the very next request.

**Fingerprint.** `sha256` (first 16 hex) over the provider's stable credential
inputs, read without network and never logged:

- its `auth.json` entry (`<agentDir>/auth.json`, the file `/login` writes) with
  the rotating fields `access` and `expires` removed, so a token refresh is not a
  change but a new login (new `refresh`, `accountId`, `key`) is;
- its `models.json` `apiKey` value as configured (the literal or the `!command`
  text, not its output).
- No entry in either: the fixed fingerprint `none`; logging in turns it into a
  real one.

Known limit: a key that a `!command` decrypts from a file changes without
changing the command text, so replacing that file is picked up only when the
backoff ends (at most 6 h) or by `/model-alias-reset-cooldown`.

The fingerprint check runs only for providers that have an `account` entry, so
a request costs one small file read per dead provider and nothing otherwise.

### 3. Status and warnings

- The cooldown warning names the class: `account unavailable; skipping
  <provider>/* until <time> or a new login`.
- `/model-alias-targets` shows the same reason for a cooled provider.
- No new transcript warning per skipped request: one warning per recorded
  failure, as today.

## Components touched

| File | Change |
|---|---|
| `src/fallback/cooldown.ts` | `classifyFailure(reason, status?)` → `quota` / `account` / `transient`; `ACCOUNT_COOLDOWN_POLICY` |
| `src/fallback/chain.ts` | provider-wide cooldown and later-target skip for `account`; pass the fingerprint into `recordFailure` |
| `src/fallback/types.ts` | `CooldownState.credential?`, `CooldownRegistry.clear` |
| `src/cooldown-store.ts` | persist `credential`; `clear(key)` with the same lock/atomic write as `recordFailure` |
| `src/stream/credential-fingerprint.ts` (new) | read `auth.json` / `models.json`, hash, never return or log values |
| `src/stream/alias-stream.ts` | clear changed-credential entries before `runFallbackChain` |
| `README.md` | Behaviour section: the account class and re-login recovery |

## Testing

- Unit: each real reason in the Evidence table (anonymised, provider-neutral
  where the README requires) maps to its class; 5xx/429/`temporarily
  unavailable` never map to `account`.
- Chain: an `account` failure cools `<provider>/*`, skips later same-provider
  targets, and stores the fingerprint; a changed fingerprint clears the entry
  and the provider is tried first again; an unchanged one keeps it cooled.
- Store: state files without `credential` still load; `clear` survives two
  processes writing concurrently (existing store test pattern).
- Fingerprint: `access`/`expires` changes keep it; a new `refresh` or a key
  change alters it; values never appear in the debug log.
- Coverage gate stays at 95 % (CONTRIBUTING).
- **Replay before done:** run the classifier over every debug log on disk and
  report the class counts; invariant: no 5xx, 429 or `temporarily unavailable`
  reason in `account`, every `is unavailable:` reason in `account`.
- **One real run:** on a test host, log out of one provider (`/logout`), send a
  request through an alias that leads with it (skipped, provider cooled), log
  back in, send again (served by that provider on the first request).

## Out of scope

- ct-dotfiles `ct-doctor`: a chain provider without credentials becomes a WARN
  ("the alias skips it") instead of a FAIL — a separate small MR there.
- Detecting a renewed subscription whose credential did not change (credits
  topped up, plan renewed on the same login): handled by the backoff and, for
  quota, by `quotaResetCommand`.
