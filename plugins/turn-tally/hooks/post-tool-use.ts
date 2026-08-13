/**
 * `post-tool-use` hook: counts each tool result against the conversation's
 * tally. The context carries the result but not the tool's name, so the
 * hook resolves it from the issuing `tool_use` block in the history
 * (matched by `tool_use_id`). Observation-only: `toolResponse` flows to
 * the provider untouched.
 */

import type { HookFunction, PostToolUseContext } from "@vellumai/plugin-api";

import { getActiveConfig } from "../src/plugin-config.js";
import { recordToolUse } from "../src/tally-store.js";

/** Find the name of the tool_use block that produced this result. */
function resolveToolName(ctx: PostToolUseContext): string | null {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    for (const block of ctx.messages[i].content) {
      if (
        block.type === "tool_use" &&
        block.id === ctx.toolResponse.tool_use_id
      ) {
        return block.name;
      }
    }
  }
  return null;
}

const postToolUse: HookFunction<PostToolUseContext> = async (ctx) => {
  const toolName = getActiveConfig().trackToolNames
    ? resolveToolName(ctx)
    : null;
  recordToolUse(ctx.conversationId, toolName);
};

export default postToolUse;
