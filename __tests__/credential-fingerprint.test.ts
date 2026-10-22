import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("non-object files, entries and nested values are handled", () => {
	assert.equal(credentialFingerprint("acct", "/agent", files("null", "null")), "none");
	assert.equal(credentialFingerprint("acct", "/agent", files([], { providers: "x" })), "none");
	assert.equal(credentialFingerprint("acct", "/agent", files({ acct: "str" }, { providers: { acct: null } })), "none");
	assert.equal(credentialFingerprint("acct", "/agent", files({}, { providers: { acct: { apiKey: 5 } } })), "none");
	const nested = (order: boolean) => (order ? { a: [{ y: 1, x: 2 }], b: null } : { b: null, a: [{ x: 2, y: 1 }] });
	assert.equal(
		credentialFingerprint("acct", "/agent", files({ acct: nested(true) }, undefined)),
		credentialFingerprint("acct", "/agent", files({ acct: nested(false) }, undefined)),
	);
});

test("default reader reads the real agent dir and treats a missing dir as none", () => {
	const dir = mkdtempSync(join(tmpdir(), "fp-"));
	assert.equal(credentialFingerprint("acct", dir), "none");
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ acct: OAUTH }));
	assert.match(credentialFingerprint("acct", dir), /^[0-9a-f]{16}$/);
	mkdirSync(join(dir, "sub"));
	assert.equal(credentialFingerprint("acct", join(dir, "sub")), "none");
});

// XAI_API_KEY is the env var pi-ai's getEnvApiKey reads for provider "xai".
test("an env-only key gives a 16-hex fingerprint that follows the env value", () => {
	const none = files({}, { providers: {} });
	const first = credentialFingerprint("xai", "/agent", none, { XAI_API_KEY: "env-key-1" });
	assert.match(first, /^[0-9a-f]{16}$/);
	assert.notEqual(credentialFingerprint("xai", "/agent", none, { XAI_API_KEY: "env-key-2" }), first);
	assert.equal(credentialFingerprint("xai", "/agent", none, { XAI_API_KEY: "env-key-1" }), first);
});

test("an apiKey naming an env var hashes the variable's value", () => {
	for (const apiKey of ["$ACCT_KEY", "${ACCT_KEY}", "Bearer-$ACCT_KEY"]) {
		const models = files({}, { providers: { acct: { apiKey } } });
		const first = credentialFingerprint("acct", "/agent", models, { ACCT_KEY: "v1" });
		assert.notEqual(credentialFingerprint("acct", "/agent", models, { ACCT_KEY: "v2" }), first, apiKey);
	}
	// "$$" and "$!" are escapes, not variable references.
	const escaped = files({}, { providers: { acct: { apiKey: "lit$$ACCT_KEY$!" } } });
	assert.equal(
		credentialFingerprint("acct", "/agent", escaped, { ACCT_KEY: "v1" }),
		credentialFingerprint("acct", "/agent", escaped, { ACCT_KEY: "v2" }),
	);
});

test("an env key is ignored while auth.json or models.json supplies the credential", () => {
	const stored = files({ xai: OAUTH }, undefined);
	assert.equal(
		credentialFingerprint("xai", "/agent", stored, { XAI_API_KEY: "env-key-1" }),
		credentialFingerprint("xai", "/agent", stored, { XAI_API_KEY: "env-key-2" }),
	);
	const configured = files({}, { providers: { xai: { apiKey: "!cmd" } } });
	assert.equal(
		credentialFingerprint("xai", "/agent", configured, { XAI_API_KEY: "env-key-1" }),
		credentialFingerprint("xai", "/agent", configured, { XAI_API_KEY: "env-key-2" }),
	);
});

test("a credential without env references keeps its earlier fingerprint", () => {
	const text = JSON.stringify({ apiKey: "!cmd", auth: { accountId: "u1", refresh: "r1", type: "oauth" } });
	const expected = createHash("sha256").update(text).digest("hex").slice(0, 16);
	const both = files({ acct: OAUTH }, { providers: { acct: { apiKey: "!cmd" } } });
	assert.equal(credentialFingerprint("acct", "/agent", both, { ACCT_KEY: "v1" }), expected);
});

test("the fingerprint never contains an env key value", () => {
	const value = credentialFingerprint("xai", "/agent", files({}, undefined), { XAI_API_KEY: "env-key-1" });
	assert.equal(value.includes("env-key-1"), false);
});
