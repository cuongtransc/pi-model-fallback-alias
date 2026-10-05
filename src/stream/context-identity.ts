import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { ALIAS_API_ID } from "../alias/api-registration.ts";

/**
 * Concrete target identity recorded on an alias-authored assistant message.
 *
 * `responseModel` records only the target's model id, which is ambiguous: two
 * providers can serve the same id with different reasoning-signature formats.
 * Recording the provider and api as well lets a later turn tell whether a stored
 * message was produced by the target it is about to be replayed to.
 */
export interface AliasTargetIdentity {
	api: string;
	provider: string;
	model: string;
}

interface AliasStoredMessage extends AssistantMessage {
	aliasTarget?: AliasTargetIdentity;
}

/**
 * Project conversation history onto the concrete target that is about to
 * receive it, without mutating the caller's context.
 *
 * `pi-ai`'s `transformMessages` treats an assistant message as native reasoning
 * only when its `api`/`provider`/`model` match the model being called. Alias
 * history carries the alias identity instead, so without this projection every
 * stored `thinking` block would be rewritten to plain text and a target's own
 * encrypted signature dropped — raw chain-of-thought the provider then flags.
 *
 * - Alias history from this same target adopts the target's real identity, so
 *   its thinking blocks and signatures replay as native reasoning.
 * - Alias history from any other target (including legacy history with no
 *   recorded target) has its thinking blocks dropped rather than converted.
 * - Every other message passes through unchanged.
 */
export function mapContextToTarget(context: Context, target: Model<Api>): Context {
	let changed = false;
	const messages = context.messages.map((message) => {
		if (message.role !== "assistant" || message.api !== ALIAS_API_ID) return message;
		changed = true;
		const { aliasTarget: recorded, ...rest } = message as AliasStoredMessage;
		if (sameTarget(recorded, target)) {
			return { ...rest, api: target.api, provider: target.provider, model: target.id };
		}
		return { ...rest, content: rest.content.filter((block) => block.type !== "thinking") };
	});
	return changed ? { ...context, messages } : context;
}

function sameTarget(recorded: AliasTargetIdentity | undefined, target: Model<Api>): boolean {
	return (
		recorded !== undefined &&
		recorded.provider === target.provider &&
		recorded.model === target.id &&
		recorded.api === target.api
	);
}
