/**
 * `user-prompt-submit` hook for the echo plugin.
 *
 * Purely observational — logs one structured line to stderr and returns
 * `void`, leaving the threaded context (message list, injections) untouched.
 *
 * Convention: the default export is the function the harness invokes.
 */

import type { UserPromptSubmitContext } from "@vellumai/plugin-api";

import { emit } from "../src/emit.js";

export default async function userPromptSubmit(
  ctx: UserPromptSubmitContext,
): Promise<void> {
  emit("user-prompt-submit", ctx.conversationId);
}
