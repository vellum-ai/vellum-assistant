import type { PlaygroundRouteDeps } from "./deps.js";

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

/**
 * Defense-in-depth guard every playground route calls first. Returns a 404
 * Response when the `compaction-playground` feature flag is disabled so the
 * entire /playground/* surface is invisible in production regardless of UI
 * gating.
 */
export function assertPlaygroundEnabled(
  deps: PlaygroundRouteDeps,
): Response | null {
  if (!deps.isPlaygroundEnabled()) {
    return Response.json(
      {
        error: {
          code: PLAYGROUND_DISABLED_CODE,
          message: "Compaction playground is not enabled",
        },
      },
      { status: 404 },
    );
  }
  return null;
}
