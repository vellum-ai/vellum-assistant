/**
 * Default `titleGenerate` behavior: kicks off conversation-title generation.
 *
 * This module is side-effect free: importing it does not register any plugin.
 *
 * Delegates to {@link queueGenerateConversationTitle}, which schedules title
 * generation as fire-and-forget background work and falls back to a
 * deterministic placeholder on failure.
 */

import { queueGenerateConversationTitle } from "../../../memory/conversation-title-service.js";
import type { TitleArgs, TitleResult } from "../../types.js";

/**
 * Invoke the title-generation service with the provided arguments. Exported
 * for tests that want to exercise the default directly.
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
