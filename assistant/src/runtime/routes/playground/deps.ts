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
  /**
   * List non-archived conversations whose title starts with `prefix`. Used by
   * the seeded-conversation endpoints (GET list + bulk DELETE) to enumerate
   * the playground-owned set without exposing every conversation.
   */
  readonly listConversationsByTitlePrefix: (prefix: string) => Array<{
    id: string;
    title: string;
    messageCount: number;
    createdAt: number;
  }>;
  /**
   * Delete a conversation by ID. Returns `true` when a row was deleted, or
   * `false` if no conversation with that ID exists. Kept narrow (no
   * memory/vector cleanup surface) so route handlers don't accidentally
   * skip the async cleanup the daemon handles elsewhere; the playground
   * delete path is intentionally best-effort for freshly-seeded rows.
   */
  readonly deleteConversationById: (id: string) => boolean;
  // Later PRs will extend this interface with additional capabilities.
  // Keep this list minimal.
}
