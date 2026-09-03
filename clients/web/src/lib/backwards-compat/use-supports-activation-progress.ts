/**
 * Backwards-compat gate: the `/v1/activation/*` progress resource.
 *
 * Old behavior (< MIN_VERSION): the daemon has no activation routes, so the
 * progress read 404s and a launch could never be linked to its conversation.
 * The whole surface stays hidden below the floor. There is no local-only
 * fallback on purpose: progress has to converge across the desktop, web and
 * mobile clients, and a client-side copy would strand a checklist on one
 * device and re-offer finished tasks on the next.
 *
 * New behavior (>= MIN_VERSION): the routes exist, the modal and pill can
 * render, and a completed turn flips a row through the `activation:progress`
 * sync tag.
 *
 * MIN_VERSION invariant: 0.11.9 is the first version carrying the routes and
 * the agent-loop hooks that mark a task done. `versionSupports` compares base
 * versions first, so a lower floor would admit routeless 0.11.8 builds and
 * 404 against them on every mount.
 *
 * Scoped to the assistant the surface reads for via
 * `useAssistantScopedSupports` (see its JSDoc in `./utils.ts`). Switching from
 * a new assistant to an older one changes the active id one render before the
 * identity fetch replaces the version, so an unscoped gate would stay `true`
 * across that render and enable the progress read against the older assistant,
 * caching a 404 for it.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.9";

/**
 * Render-path gate for every activation surface. `false` while the version is
 * unknown or still held for another assistant, which keeps the feature hidden
 * until identity resolves for `ownerAssistantId`.
 */
export function useSupportsActivationProgress(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
