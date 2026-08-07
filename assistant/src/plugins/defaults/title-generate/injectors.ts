/**
 * `title-generate` plugin injectors.
 *
 * Contributes the one block this plugin needs the assistant to see: a notice
 * that conversation titling is failing, emitted on a turn that would otherwise
 * spend a title call and get nothing back.
 *
 * The plugin's hooks are pure triggers into a fire-and-forget pipeline, so a
 * title failure is invisible from inside the turn that caused it. The
 * `conversation-title-health` latch carries an already-observed failure
 * forward, and this injector is where it re-enters the conversation.
 */

import { getConversation } from "../../../persistence/conversation-crud.js";
import {
  claimTitleModelFaultNotice,
  type TitleModelFault,
} from "../../../persistence/conversation-title-health.js";
import { canReplaceTitle } from "../../../persistence/conversation-title-service.js";
import type { InjectionBlock, Injector, TurnContext } from "../../types.js";
import { DEFAULT_INJECTOR_ORDER } from "../injector-order.js";

/** Opening tag — shared with the compaction strip so the two cannot drift. */
export const TITLE_GENERATION_UNAVAILABLE_PREFIX =
  "<title_generation_unavailable>";

export function buildTitleGenerationUnavailableBlock(
  fault: TitleModelFault,
): string {
  const routing = [
    fault.model ? `model: ${fault.model}` : null,
    fault.connectionName ? `connection: ${fault.connectionName}` : null,
  ].filter((line): line is string => line !== null);

  return [
    TITLE_GENERATION_UNAVAILABLE_PREFIX,
    'This conversation cannot be auto-titled. The conversationTitle call site resolves to a model the connection serving it refuses, so the title falls back to "Untitled Conversation" and will keep doing so until that model or connection changes.',
    ...routing,
    "",
    "Do not raise this on your own — it has nothing to do with what the user asked. Answer their message normally. Only if they ask why conversations are not being named should you explain it, and then run `assistant inference callsites get conversationTitle` first so you describe the live resolution rather than this snapshot.",
    "</title_generation_unavailable>",
  ].join("\n");
}

/**
 * `title-generation-unavailable` injector — prepend-user-tail.
 *
 * Gated on the same condition the title service itself uses to decide whether
 * to spend a call (`canReplaceTitle`), so the notice can only appear on a turn
 * where titling would genuinely have been attempted — never on a conversation
 * the user has named, and never on one already carrying a generated title.
 *
 * That gate alone does not bound the notice, which is why the latch claims one
 * per conversation: a failed title leaves the conversation replaceable, so
 * "would we generate a title" stays true on every later turn of every
 * conversation for as long as the fault lasts.
 */
const titleGenerationUnavailableInjector: Injector = {
  name: "title-generation-unavailable",
  order: DEFAULT_INJECTOR_ORDER.titleGenerationUnavailable,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    let conversation;
    try {
      conversation = getConversation(ctx.conversationId);
    } catch {
      // A read failure is not evidence of a titling fault. Say nothing.
      return null;
    }
    if (!conversation || !canReplaceTitle(conversation)) {
      return null;
    }
    const fault = claimTitleModelFaultNotice(ctx.conversationId);
    if (!fault) {
      return null;
    }
    return {
      id: "title-generation-unavailable",
      text: buildTitleGenerationUnavailableBlock(fault),
      placement: "prepend-user-tail",
    };
  },
};

export const titleGenerateInjectors: Injector[] = [
  titleGenerationUnavailableInjector,
];
