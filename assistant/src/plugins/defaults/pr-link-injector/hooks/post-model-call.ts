/**
 * Default `post-model-call` hook for the pr-link-injector plugin.
 *
 * When the main agent is about to end its turn with a text reply, this hook
 * checks whether a PR link was discovered by the sibling `post-tool-use` hook
 * (after a `git push`) but not already mentioned in the assistant's text. If
 * so, it appends a text block with the PR URL to the finalized content so the
 * user sees the link without the model having to remember to include it.
 *
 * The hook only acts on finalized, no-tool, main-agent replies — the same
 * gating as the surface-completion-nudge hook. Tool-bearing turns continue
 * naturally (the model may still mention the link on its own), and background
 * call sites have no user watching.
 */

import type { PluginHookFn, PostModelCallContext } from "@vellumai/plugin-api";

import type { ContentBlock } from "../../../../providers/types.js";
import { getPrLink } from "../pr-link-store.js";

/** Whether the content array has any tool_use blocks. */
function hasToolUse(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some((block) => block.type === "tool_use");
}

/** Concatenate all text blocks in the content array. */
function extractText(content: ReadonlyArray<ContentBlock>): string {
  return content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

const postModelCall: PluginHookFn<PostModelCallContext> = async (ctx) => {
  // Only act on the user-facing reply.
  if (ctx.callSite !== "mainAgent") return;

  // Provider rejection — no content to augment.
  if (ctx.error) return;

  // Tool-bearing turn continues naturally — the model may still mention the
  // link on its own. Only inject on the final text-only reply.
  if (hasToolUse(ctx.content)) return;

  const prUrl = getPrLink(ctx.conversationId);
  if (!prUrl) return;

  // Check if the model already mentioned the PR link in its text.
  const text = extractText(ctx.content);
  if (text.includes(prUrl)) return;

  // Append the PR link as a final text block.
  ctx.content.push({
    type: "text",
    text: `\n\nPR: ${prUrl}`,
  });

  ctx.logger.info(
    {
      plugin: "pr-link-injector",
      conversationId: ctx.conversationId,
      prUrl,
    },
    "Injected PR link into final reply",
  );
};

export default postModelCall;
