/**
 * `user-prompt-submit` hook for the memory-reference plugin.
 *
 * Before the turn reaches the agent loop, retrieve memories relevant to the
 * submitted prompt (vector search via the runtime captured at `init`, biased by
 * recent conversation context from `host.history`) and inject them as a
 * `<memory>` block. The hook mutates `latestMessages` in place — prepending a
 * synthetic user message that carries the block — and returns void, so the rest
 * of the threaded context flows through untouched.
 *
 * Imports ONLY `@vellumai/plugin-api`.
 */

import type {
  Message,
  TextContent,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import {
  DEFAULT_RECALL_LIMIT,
  extractText,
  recallFacts,
  renderMemoryBlock,
  tryGetRuntime,
} from "../src/state.js";

export default async function userPromptSubmit(
  ctx: UserPromptSubmitContext,
): Promise<void> {
  const rt = tryGetRuntime();
  if (rt === null) return;

  // Build the retrieval query from the submitted prompt plus a little recent
  // context, so a terse follow-up ("and the second one?") still retrieves
  // against what the conversation is actually about.
  let query = ctx.prompt;
  try {
    const recent = await rt.history.getRecentMessages(ctx.conversationId, 4);
    const context = recent
      .map((m) => extractText(m.content))
      .filter((t) => t.length > 0)
      .join("\n");
    if (context.length > 0) {
      query = `${context}\n${ctx.prompt}`;
    }
  } catch (err) {
    ctx.logger.warn(
      {
        plugin: "memory-reference",
        err: err instanceof Error ? err.message : String(err),
      },
      "memory-reference: history fetch failed; querying on prompt alone",
    );
  }

  let facts;
  try {
    facts = await recallFacts(rt, query, DEFAULT_RECALL_LIMIT);
  } catch (err) {
    ctx.logger.warn(
      {
        plugin: "memory-reference",
        err: err instanceof Error ? err.message : String(err),
      },
      "memory-reference: recall failed; skipping injection",
    );
    return;
  }
  if (facts.length === 0) return;

  const block: TextContent = {
    type: "text",
    text: renderMemoryBlock(facts.map((f) => f.text)),
  };
  const memoryMessage: Message = { role: "user", content: [block] };
  ctx.latestMessages.unshift(memoryMessage);

  ctx.logger.info(
    { plugin: "memory-reference", injected: facts.length },
    "memory-reference: injected memory block",
  );
}
