import assert from "node:assert/strict";
import test from "node:test";
import type { StreamOptions } from "@earendil-works/pi-ai";
import { ALIAS_GATE_API_KEY } from "../src/alias/auth-gate.ts";
import { requestOptions } from "../src/stream/request-options.ts";

test("never forwards the alias gate when the target auth has no key", () => {
	const options = requestOptions({ apiKey: ALIAS_GATE_API_KEY }, {}, undefined);
	assert.equal(options.apiKey, undefined);
});

test("target auth apiKey replaces the alias gate", () => {
	const options = requestOptions({ apiKey: ALIAS_GATE_API_KEY }, { apiKey: "TARGET-KEY" }, undefined);
	assert.equal(options.apiKey, "TARGET-KEY");
});

test("target auth env wins over the caller's env", () => {
	const options = requestOptions(
		{ apiKey: ALIAS_GATE_API_KEY, env: { AWS_PROFILE: "stale-profile", OTHER: "kept" } },
		{ env: { AWS_PROFILE: "target-profile" } },
		undefined,
	);
	assert.deepEqual(options.env, { AWS_PROFILE: "target-profile", OTHER: "kept" });
});

test("target auth headers win over caller headers, non-auth headers still flow", () => {
	const options = requestOptions(
		{ apiKey: ALIAS_GATE_API_KEY, headers: { authorization: "Bearer stale", "x-request-id": "req-1" } },
		{ headers: { authorization: "Bearer target" } },
		undefined,
	);
	assert.deepEqual(options.headers, { authorization: "Bearer target", "x-request-id": "req-1" });
});

test("drops the caller's authorization header when the target auth defines no headers", () => {
	const options = requestOptions(
		{ headers: { Authorization: "Bearer other-provider", "x-request-id": "req-1" } },
		{},
		undefined,
	);
	assert.deepEqual(options.headers, { "x-request-id": "req-1" });
});

test("strips caller credential headers while keeping non-auth headers", () => {
	const options = requestOptions(
		{ headers: { "x-api-key": "stale-key", "anthropic-version": "2023-06-01", "x-request-id": "req-1" } },
		{ headers: { authorization: "Bearer target" } },
		undefined,
	);
	assert.deepEqual(options.headers, { authorization: "Bearer target", "x-request-id": "req-1" });
});

test("headers become undefined when the caller supplies only credential headers", () => {
	const options = requestOptions({ headers: { authorization: "Bearer stale" } }, {}, undefined);
	assert.equal(options.headers, undefined);
});

test("keeps headers undefined when neither side supplies any", () => {
	const options = requestOptions<StreamOptions>({}, {}, undefined);
	assert.equal(options.headers, undefined);
});

test("prefers the linked signal over the caller's", () => {
	const caller = new AbortController();
	const linked = new AbortController();
	assert.equal(requestOptions({ signal: caller.signal }, {}, linked.signal).signal, linked.signal);
	assert.equal(requestOptions({ signal: caller.signal }, {}, undefined).signal, caller.signal);
});

test("adds the OpenCode session headers pi derives from the alias model, not the target", () => {
	const opencode = { provider: "opencode-ct", baseUrl: "https://opencode.ai/zen/go/v1" };
	const options = requestOptions<StreamOptions>({ sessionId: "sess-1", headers: { "x-extra": "1" } }, {}, undefined, opencode);
	assert.deepEqual(options.headers, { "x-extra": "1", "x-opencode-session": "sess-1", "x-opencode-client": "pi" });

	const builtIn = requestOptions<StreamOptions>({ sessionId: "sess-2" }, {}, undefined, { provider: "opencode-go", baseUrl: "https://x.invalid" });
	assert.equal(builtIn.headers?.["x-opencode-session"], "sess-2");
});

test("adds no OpenCode session header for another provider or without a session", () => {
	const other = { provider: "xai", baseUrl: "https://api.x.ai/v1" };
	assert.equal(requestOptions<StreamOptions>({ sessionId: "sess-1" }, {}, undefined, other).headers, undefined);
	const opencode = { provider: "opencode-ct", baseUrl: "https://opencode.ai/zen/go/v1" };
	assert.equal(requestOptions<StreamOptions>({}, {}, undefined, opencode).headers, undefined);
	assert.equal(requestOptions<StreamOptions>({ sessionId: "s" }, {}, undefined, { provider: "p", baseUrl: "not a url" }).headers, undefined);
});
