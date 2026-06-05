/**
 * `post-tool-use` hook for the echo plugin.
 *
 * Purely observational — logs one structured line to stderr and returns
 * `void`, leaving the tool result untouched.
 *
 * Convention: the default export is the function the harness invokes.
 */

import type { PostToolUseContext } from "@vellumai/plugin-api";

import { emit } from "../src/emit.js";

export default async function postToolUse(
  ctx: PostToolUseContext,
): Promise<void> {
  emit("post-tool-use", ctx.conversationId);
}
