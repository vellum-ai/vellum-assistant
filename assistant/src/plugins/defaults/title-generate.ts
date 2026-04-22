/**
 * Default `titleGenerate` pipeline plugin.
 *
 * The terminal for the `titleGenerate` pipeline. Delegates to
 * {@link queueGenerateConversationTitle}, which schedules title generation
 * as fire-and-forget background work and falls back to a deterministic
 * placeholder on failure.
 *
 * Custom plugins may install middleware that short-circuits this terminal
 * (e.g. a deterministic generator for tests, or an alternative LLM routing
 * policy). When no middleware is installed the pipeline calls this
 * terminal directly and behavior is bit-identical to the pre-plugin code
 * path.
 *
 * Registered via a side-effect import from
 * `daemon/external-plugins-bootstrap.ts` so it is present in the registry
 * by the time {@link bootstrapPlugins} runs.
 */

import { queueGenerateConversationTitle } from "../../memory/conversation-title-service.js";
import type { Plugin, TitleArgs, TitleResult } from "../types.js";

/**
 * Invoke the title-generation service with the provided arguments. Used as
 * the terminal handler for the `titleGenerate` pipeline in
 * `conversation-agent-loop.ts`, and re-exported for tests that want to
 * exercise the default directly.
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

/**
 * Default titleGenerate plugin. Declares no middleware — it exists purely
 * to negotiate the `titleGenerateApi` capability so bootstrap has a record
 * that the assistant runtime exposes this pipeline.
 *
 * The terminal is supplied at the call site in
 * `conversation-agent-loop.ts` (see {@link defaultTitleGenerateTerminal})
 * rather than through `middleware.titleGenerate`, because a default
 * middleware would short-circuit user-registered middleware by always
 * running first in onion order. Keeping the terminal outside the
 * middleware chain lets user plugins observe/transform/short-circuit the
 * call without competing with an assistant-owned default middleware.
 */
export const defaultTitleGeneratePlugin: Plugin = {
  manifest: {
    name: "default-title-generate",
    version: "1.0.0",
    provides: { titleGenerate: "v1" },
    requires: {
      pluginRuntime: "v1",
      titleGenerateApi: "v1",
    },
  },
};
