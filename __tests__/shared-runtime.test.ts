import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { installPiModelAlias } from "../index.ts";
import { createCooldownRegistry, parseAliasConfig } from "../src/fallback/index.ts";
import { FAILOVER_ENTRY } from "../src/status/transcript.ts";

// An in-process subagent loads the extension again into the parent's model runtime, and
// the provider it registers last serves every session in the process.
test("a session's footer and failover entries follow its calls served by a later load", async () => {
	const failing = new Set<string>();
	const cooldowns = createCooldownRegistry();
	const config = parseAliasConfig({ coder: ["provider/first", "provider/second"] });
	const main = load({ sessionId: "main", hasUI: true, config, cooldowns, failing });
	await main.call("main");
	assert.match(main.statuses.at(-1) ?? "", /provider\/first/);

	const sub = load({ sessionId: "sub", hasUI: false, config, cooldowns, failing });
	failing.add("first");
	await sub.call("main");

	assert.match(main.statuses.at(-1) ?? "", /provider\/second/);
	assert.deepEqual(main.entries.filter((type) => type === FAILOVER_ENTRY), [FAILOVER_ENTRY]);
	assert.deepEqual(sub.entries.filter((type) => type === FAILOVER_ENTRY), []);
});

function load(options: {
	sessionId: string;
	hasUI: boolean;
	config: ReturnType<typeof parseAliasConfig>;
	cooldowns: ReturnType<typeof createCooldownRegistry>;
	failing: Set<string>;
}) {
	const statuses: string[] = [];
	const entries: string[] = [];
	const listeners = new Map<string, (...args: never[]) => unknown>();
	let provider: { stream(model: Model<Api>, context: unknown, options: unknown): AsyncIterable<AssistantMessageEvent> } | undefined;
	const pi = {
		appendEntry(type: string) { entries.push(type); },
		registerEntryRenderer() {},
		registerProvider(registered: typeof provider) { provider = registered; },
		on(event: string, handler: (...args: never[]) => unknown) { listeners.set(event, handler); },
		registerCommand() {},
	};
	installPiModelAlias(pi as never, { aliasConfig: options.config, debugLog: { log() {} }, cooldowns: options.cooldowns });
	listeners.get("session_start")?.({} as never, {
		model: { id: "coder", provider: "alias" },
		modelRegistry: registry(options.failing),
		hasUI: options.hasUI,
		ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: (_key: string, value?: string) => statuses.push(value ?? "") },
		sessionManager: { getSessionId: () => options.sessionId },
	} as never);
	return {
		statuses,
		entries,
		async call(sessionId: string) {
			for await (const _event of provider!.stream(model("coder"), { messages: [] }, { sessionId }));
		},
	};
}

function registry(failing: Set<string>) {
	return {
		find: (_provider: string, id: string) => ({ ...model(id), provider: "provider", api: "test" }),
		getProvider: () => ({
			async *stream(target: Model<Api>): AsyncGenerator<AssistantMessageEvent> {
				const failed = failing.has(target.id);
				const message = { ...reply(target.id), ...(failed ? { stopReason: "error" as const } : {}) };
				yield failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message };
			},
		}),
		getApiKeyAndHeaders: async () => ({ ok: true }),
	};
}

function model(id: string): Model<Api> {
	return {
		id, name: id, api: "alias-delegate", provider: "alias", baseUrl: "https://alias.invalid", reasoning: false,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1,
	};
}

function reply(id: string): AssistantMessage {
	return {
		role: "assistant", content: [], api: "test", provider: "provider", model: id, stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
