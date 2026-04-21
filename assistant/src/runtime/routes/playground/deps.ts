/**
 * Shared dependency contract for every `/v1/.../playground/*` route.
 *
 * Each playground route file accepts a `PlaygroundRouteDeps` and calls
 * `assertPlaygroundEnabled(deps)` before doing any real work, so the route
 * group is invisible in production regardless of UI gating.
 *
 * Later PRs in the compaction-playground plan (PR 6, PR 16, ...) extend this
 * interface with additional capabilities. The scaffold keeps the surface
 * intentionally minimal.
 */

import type { Conversation } from "../../../daemon/conversation.js";

export interface PlaygroundRouteDeps {
  readonly getConversationById: (id: string) => Conversation | undefined;
  readonly isPlaygroundEnabled: () => boolean;
  // Later PRs (PR 6, PR 16) will extend this interface with additional
  // capabilities. Keep this list minimal for scaffold.
}
