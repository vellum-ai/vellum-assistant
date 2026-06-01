/**
 * Terminal handler for the default `titleGenerate` pipeline.
 *
 * This module is side-effect free: importing it does not register any plugin.
 * The terminal is wired in as the pipeline's `terminal` argument by the
 * `runPipeline` call site in `daemon/conversation-agent-loop.ts`.
 *
 * Delegates to {@link queueGenerateConversationTitle}, which schedules title
 * generation as fire-and-forget background work and falls back to a
 * deterministic placeholder on failure.
 *
 * Custom plugins may install middleware that short-circuits this terminal
 * (e.g. a deterministic generator for tests, or an alternative LLM routing
 * policy). When no middleware is installed the pipeline calls this terminal
 * directly and behavior is bit-identical to the pre-plugin code path.
 */

import { queueGenerateConversationTitle } from "../../../memory/conversation-title-service.js";
import type { TitleArgs, TitleResult } from "../../types.js";

/**
 * Invoke the title-generation service with the provided arguments. Used as
 * the terminal handler for the `titleGenerate` pipeline in
 * `conversation-agent-loop.ts`, and exported for tests that want to exercise
 * the default directly.
 *
 * Returns an empty result — the service is fire-and-forget and surfaces its
 * output through `onTitleUpdated`.
 */
export async function defaultTitleGenerateTerminal(
  args: TitleArgs,
): Promise<TitleResult> {
  queueGenerateConversationTitle({
    conversationId: args.conversationId,
    provider: args.provider,
    userMessage: args.userMessage,
    onTitleUpdated: args.onTitleUpdated,
  });
  return {};
}
