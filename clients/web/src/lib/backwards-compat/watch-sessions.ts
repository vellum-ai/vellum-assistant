/**
 * Backwards-compat gate: watch sessions.
 *
 * A watch session opens `/v1/watch/stream` on the daemon
 * (`assistant/src/runtime/routes/watch-routes.ts`) and streams narration
 * audio to it. An assistant that predates the route refuses the upgrade, so
 * without this gate a press of Watch reaches `openSession`, flips the global
 * `watching` flag, and only then fails the handshake. The companion surface
 * lights its capture ring for a session that never existed, which is the one
 * failure this feature cannot afford: an indicator that claims a screen is
 * being read is worthless the moment it can be wrong in either direction.
 *
 * - Old behavior (< MIN_VERSION): Watch is inert. The press opens no socket,
 *   the microphone stays closed, and nothing is published, so the surface
 *   draws exactly what it draws when no session is running.
 * - New behavior (>= MIN_VERSION): the press opens the stream and the session
 *   runs.
 *
 * Scoped to the assistant the session would belong to, via
 * `assistantScopedSupports`, for the same reason the session itself is bound
 * to that assistant (`watch-controller.ts`): a version fetched for the
 * outgoing assistant must never authorize a capture against the incoming one.
 *
 * MIN_VERSION is a dev floor rather than a predicted release number, per the
 * guidance in `docs/BACKWARDS_COMPAT.md`. It names the merge that puts the
 * route on `main` (#41133, 2026-08-21 20:20 UTC) on top of the then-current
 * base `0.11.4`. The merge is the instant that matters rather than the commit
 * that writes the route, because dev builds are cut from `main`: a build
 * carrying a feature-branch timestamp satisfies a floor for code `main` does
 * not hold. Every dev build from this instant on serves the route, and every
 * later release clears the floor without anyone having to guess a number.
 */

import {
  assistantScopedSupports,
  whenAssistantVersionKnownFor,
} from "@/lib/backwards-compat/utils";

export const MIN_VERSION = "0.11.4-dev.202608212020.70f2864";

/**
 * Whether `assistantId` is new enough to serve `/v1/watch/stream`.
 *
 * Conservative (`false`) until the scoped version hydrates and on any owner
 * mismatch, which leaves Watch inert. Snapshot rather than a hook because the
 * only caller is imperative: the press arrives as a `toggleWatch` command from
 * the companion surface, not from a render.
 */
export function supportsWatchSessions(
  assistantId: string | null | undefined,
): assistantId is string {
  return assistantScopedSupports(MIN_VERSION, assistantId);
}

/**
 * The same gate for a start path, resolving the version first.
 *
 * Starting a session is a write, and the snapshot above collapses "unknown"
 * and "known-old" into one `false`. A press that landed while the identity
 * fetch was still in flight would read that `false` and refuse an assistant
 * that does support watching. The scoped wait is the right one: the unscoped
 * one is satisfied by a version still held for another assistant, which the
 * owner check would then answer `false` on anyway.
 */
export async function resolveSupportsWatchSessions(
  assistantId: string | null | undefined,
): Promise<boolean> {
  await whenAssistantVersionKnownFor(assistantId);
  return supportsWatchSessions(assistantId);
}
