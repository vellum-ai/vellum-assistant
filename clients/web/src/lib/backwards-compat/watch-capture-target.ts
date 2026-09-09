/**
 * Backwards-compat gate: a watch session that can be told what to read.
 *
 * `/v1/watch/stream` takes `captureDisplayId` or `captureWindowId` on its
 * query string and scopes every screen read of the session to that display or
 * window (`assistant/src/runtime/http-server.ts`, then
 * `assistant/src/watch/watch-session-manager.ts` and the native helper). An
 * assistant that predates the parameters ignores them: the upgrade succeeds
 * and the session reads the whole main display, as every session did before.
 *
 * That silent success is the failure this gate exists for. The companion
 * surface frames whatever the session was told to read, and a frame drawn
 * around one window while the assistant reads the whole screen is an
 * indicator that is wrong in the direction that matters: it claims less is
 * being read than is.
 *
 * - Old behavior (< MIN_VERSION): the picker is not offered, Teach starts the
 *   whole-screen session it always started, and a target that reaches the
 *   controller anyway is dropped before the dial, so the session reports none
 *   and the frame follows the read.
 * - New behavior (>= MIN_VERSION): the picker is offered, the pick rides the
 *   stream's URL, and the session reports it back as its target.
 *
 * Scoped to the assistant the session would belong to, via
 * `assistantScopedSupports`, for the reason `watch-sessions.ts` is: a version
 * fetched for the outgoing assistant must never decide what the incoming one
 * is told to read.
 *
 * MIN_VERSION is a dev floor rather than a predicted release number, per
 * `docs/BACKWARDS_COMPAT.md`. It names the commit that made the gateway
 * forward the parameters, not the earlier one that taught the daemon to read
 * them: a build in between parses them and never receives them, which is
 * exactly the whole-screen-behind-a-window-frame this gate exists to prevent.
 * On top of the then-current base `0.11.8`.
 */

import { assistantScopedSupports } from "@/lib/backwards-compat/utils";

export const MIN_VERSION = "0.11.8-dev.202609031252.8641564";

/**
 * Whether `assistantId` scopes a watch session to the target on its stream.
 *
 * Conservative (`false`) until the scoped version hydrates and on any owner
 * mismatch, which leaves the session reading the whole screen. Snapshot rather
 * than a hook, because both callers are imperative: the controller reads it at
 * the dial, after the version has been resolved for this same assistant behind
 * `resolveSupportsWatchSessions`, and the companion mirror reads it on every
 * identity write to tell the surface whether to offer its picker.
 */
export function supportsWatchCaptureTarget(
  assistantId: string | null | undefined,
): assistantId is string {
  return assistantScopedSupports(MIN_VERSION, assistantId);
}
