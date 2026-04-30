import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import { getConfig } from "../../../config/loader.js";
import { RouteError } from "../errors.js";

/**
 * Body code for flag-off playground 404s. Distinct from the generic
 * `NOT_FOUND` code so the Swift `CompactionPlaygroundClient` can route
 * these to `.notAvailable` (toast: "Playground endpoints disabled")
 * rather than `.notFound` (toast: "Conversation not found"). The two
 * cases are otherwise indistinguishable on conv-scoped routes because
 * `assertPlaygroundEnabled` runs *before* the conversation lookup, so a
 * URL-path heuristic on the client misclassifies flag-off as missing-
 * conversation. See `conversation-not-found.ts` for the matching code on
 * the other branch.
 */
const PLAYGROUND_DISABLED_CODE = "playground_disabled";

function isPlaygroundEnabled(): boolean {
  return isAssistantFeatureFlagEnabled("compaction-playground", getConfig());
}

/**
 * Defense-in-depth guard every playground route calls first. Throws a
 * RouteError when the `compaction-playground` feature flag is disabled so
 * the entire /playground/* surface is invisible in production regardless
 * of UI gating.
 */
export function assertPlaygroundEnabled(): void {
  if (!isPlaygroundEnabled()) {
    throw new RouteError(
      "Compaction playground is not enabled",
      PLAYGROUND_DISABLED_CODE,
      404,
    );
  }
}
