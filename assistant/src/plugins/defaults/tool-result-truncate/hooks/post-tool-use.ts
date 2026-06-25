/**
 * Default `post-tool-use` hook: tail-drops an oversized tool result down to a
 * character budget derived from the model's context window, keeping a single
 * result from blowing the provider's context.
 *
 * Defaults register before any user plugin, so this hook runs at the front of
 * the `post-tool-use` chain — every later hook sees an already-bounded result.
 * The hook mutates `toolResponse.content` in place.
 */

import type { HookFunction, PostToolUseContext } from "@vellumai/plugin-api";

import { truncateToolResult } from "../terminal.js";

const postToolUse: HookFunction<PostToolUseContext> = async (ctx) => {
  const { content, truncated } = truncateToolResult(
    ctx.toolResponse.content,
    ctx.maxInputTokens,
  );
  if (truncated) {
    ctx.toolResponse.content = content;
    ctx.logger.warn(
      {
        plugin: "tool-result-truncate",
        toolUseId: ctx.toolResponse.tool_use_id,
      },
      "Truncated oversized tool result to prevent context overflow",
    );
  }
};

export default postToolUse;
