import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { ALIAS_API_ID } from "../src/alias/api-registration.ts";
import { mapContextToTarget, type AliasTargetIdentity } from "../src/stream/context-identity.ts";

type StoredAssistantMessage = AssistantMessage & { aliasTarget?: AliasTargetIdentity };

const TARGET_IDENTITY: AliasTargetIdentity = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-6.1-sol",
};

test("keeps a same-target thinking block and adopts the target identity", () => {
	const stored = storedMessage();
	const context: Context = { messages: [stored] };

	const mapped = mapContextToTarget(context, gptTarget());

	assert.notStrictEqual(mapped, context);
	const message = onlyAssistant(mapped);
	assert.equal(message.api, "openai-codex-responses");
	assert.equal(message.provider, "openai-codex");
	assert.equal(message.model, "gpt-6.1-sol");
	assert.equal((message as StoredAssistantMessage).aliasTarget, undefined);
	assert.deepEqual(message.content, stored.content);
});

test("drops thinking from alias history produced by a different target", () => {
	const messages: StoredAssistantMessage[] = [
		storedMessage({ aliasTarget: { api: "openai-completions", provider: "deepseek", model: "deepseek-chat" } }),
		storedMessage({ aliasTarget: { api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.4" } }),
		storedMessage({ aliasTarget: { api: "openai-completions", provider: "openai-codex", model: "gpt-6.1-sol" } }),
	];

	const mapped = mapContextToTarget({ messages }, gptTarget());

	for (const message of mapped.messages) {
		assert.equal(message.role, "assistant");
		if (message.role !== "assistant") assert.fail("expected assistant message");
		assert.deepEqual(
			message.content.map((block) => block.type),
			["text", "toolCall"],
		);
		assert.equal((message as StoredAssistantMessage).aliasTarget, undefined);
		const text = message.content.filter((block) => block.type === "text").map((block) => block.text);
		assert.deepEqual(text, ["visible answer"]);
		assert.ok(!text.includes("chain of thought"), "thinking text must never become text");
	}
});

test("drops thinking from legacy alias history with no recorded target", () => {
	const legacy = storedMessage();
	delete legacy.aliasTarget;
	assert.equal(legacy.responseModel, "gpt-6.1-sol");

	const mapped = mapContextToTarget({ messages: [legacy] }, gptTarget());

	assert.deepEqual(
		onlyAssistant(mapped).content.map((block) => block.type),
		["text", "toolCall"],
	);
});

test("leaves non-alias messages untouched and does not mutate the caller context", () => {
	const user = { role: "user" as const, content: "hi", timestamp: 0 };
	const direct = {
		...storedMessage(),
		api: "anthropic-messages" as Api,
		provider: "anthropic",
		model: "claude",
		content: [{ type: "thinking" as const, thinking: "direct", thinkingSignature: "sig" }],
	};
	const aliasHistory = storedMessage();
	const context: Context = { messages: [user, direct, aliasHistory] };

	const mapped = mapContextToTarget(context, gptTarget());

	assert.equal(mapped.messages[0], user);
	assert.equal(mapped.messages[1], direct);
	assert.equal(aliasHistory.content.length, 3);
	assert.deepEqual(aliasHistory.aliasTarget, TARGET_IDENTITY);
	assert.equal((context.messages[2] as StoredAssistantMessage).content.length, 3);
});

test("returns the same context when there is no alias history to map", () => {
	const user = { role: "user" as const, content: "hi", timestamp: 0 };
	const context: Context = { messages: [user] };

	assert.equal(mapContextToTarget(context, gptTarget()), context);
});

test("real transformMessages never turns foreign thinking into text", () => {
	const foreign = storedMessage({
		aliasTarget: { api: "openai-completions", provider: "deepseek", model: "deepseek-chat" },
	});
	const mapped = mapContextToTarget({ messages: [foreign] }, gptTarget());
	const transformed = transformMessages(mapped.messages, gptTarget(), undefined);

	const assistant = transformed.find((message) => message.role === "assistant");
	assert.ok(assistant);
	if (assistant?.role !== "assistant") assert.fail("expected assistant message");
	assert.ok(!assistant.content.some((block) => block.type === "thinking"));
	const text = assistant.content.filter((block) => block.type === "text").map((block) => block.text);
	assert.deepEqual(text, ["visible answer"]);
	assert.ok(!JSON.stringify(transformed).includes("chain of thought"));
});

test("real transformMessages replays a same-target signature as native reasoning", () => {
	const mapped = mapContextToTarget({ messages: [storedMessage()] }, gptTarget());
	const transformed = transformMessages(mapped.messages, gptTarget(), undefined);

	const assistant = transformed.find((message) => message.role === "assistant");
	assert.ok(assistant);
	if (assistant?.role !== "assistant") assert.fail("expected assistant message");
	assert.deepEqual(assistant.content[0], {
		type: "thinking",
		thinking: "chain of thought",
		thinkingSignature: "encrypted-signature",
	});
});

test("session reload keeps the recorded target fields", () => {
	const stored = storedMessage();
	const revived = JSON.parse(JSON.stringify(stored)) as StoredAssistantMessage;

	assert.deepEqual(revived.aliasTarget, TARGET_IDENTITY);

	const mapped = mapContextToTarget({ messages: [revived] }, gptTarget());
	assert.deepEqual(
		onlyAssistant(mapped).content.map((block) => block.type),
		["thinking", "text", "toolCall"],
	);
});

function onlyAssistant(context: Context): StoredAssistantMessage {
	const assistant = context.messages.find((message) => message.role === "assistant");
	assert.ok(assistant, "expected an assistant message");
	if (assistant?.role !== "assistant") assert.fail("expected assistant message");
	return assistant as StoredAssistantMessage;
}

function storedMessage(overrides: Partial<StoredAssistantMessage> = {}): StoredAssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "chain of thought", thinkingSignature: "encrypted-signature" },
			{ type: "text", text: "visible answer" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp" } },
		],
		api: ALIAS_API_ID,
		provider: "alias",
		model: "coder",
		responseModel: "gpt-6.1-sol",
		aliasTarget: { ...TARGET_IDENTITY },
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
		...overrides,
	};
}

function gptTarget(): Model<Api> {
	return {
		id: "gpt-6.1-sol",
		name: "GPT",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	};
}
