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
 * `docs/BACKWARDS_COMPAT.md`. The routes and the agent-loop hooks that mark a
 * task done landed on top of 0.11.8, so every build that carries them is
 * stamped `0.11.8-dev.*` or `0.11.8-local.*` until the next cut. The floor
 * names the minute the route commit merged (`d5d996d`), which is the earliest
 * a build can carry it: dev and local pre-releases compare AHEAD of the stable
 * release with the same base and order by their stamp, so a same-source local
 * build and every dev build cut after that minute pass, released 0.11.8 and
 * dev builds from before it do not, and later releases pass on the base
 * comparison alone with nothing predicted.
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

export const MIN_VERSION = "0.11.8-dev.202609030107.d5d996d";

/**
 * Render-path gate for every activation surface. `false` while the version is
 * unknown or still held for another assistant, which keeps the feature hidden
 * until identity resolves for the active one.
 */
export function useSupportsActivationProgress(): boolean {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  return useAssistantScopedSupports(MIN_VERSION, assistantId);
}
