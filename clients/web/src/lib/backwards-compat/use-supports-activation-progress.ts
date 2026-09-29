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
 * MIN_VERSION invariant: a dev floor rather than a release number, per
 * `docs/BACKWARDS_COMPAT.md`. Released 0.12.0 and 0.12.1 do not carry the
 * routes; 0.12.2 is the first release that does, and so does every `main`
 * build on the 0.12.1 base. The floor names the first minute of that base
 * (`5e16607`): dev and local pre-releases compare AHEAD of the stable release
 * with the same base and order by their stamp, so `main` builds from that
 * minute on pass, both route-less releases do not, and 0.12.2 and later pass
 * on the base comparison alone.
 *
 * Scoped to the active assistant via `useAssistantScopedSupports` (see its
 * JSDoc in `./utils.ts`). Switching from a new assistant to an older one
 * changes the active id one render before the identity fetch replaces the
 * version, so an unscoped gate would stay `true` across that render and enable
 * the progress read against the older assistant, caching a 404 for it. The
 * scoping is kept here, where that race lives, rather than handed to callers
 * as a parameter every one of them would fill in the same way.
 */
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.12.1-dev.202609141911.5e16607";

/**
 * Render-path gate for every activation surface. `false` while the version is
 * unknown or still held for another assistant, which keeps the feature hidden
 * until identity resolves for the active one.
 */
export function useSupportsActivationProgress(): boolean {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  return useAssistantScopedSupports(MIN_VERSION, assistantId);
}
