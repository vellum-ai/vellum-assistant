/**
 * Backwards-compat gate: the `groupId` filter on `GET /v1/conversations`.
 *
 * Old behavior (< MIN_VERSION): the route does not know the parameter. An
 * unrecognized query parameter is ignored rather than rejected, so the
 * request succeeds with 200 and returns the entire unfiltered conversation
 * list. A section asking for its own members would receive every
 * conversation and render all of them, with its unread indicator and bulk
 * actions describing that whole list.
 *
 * New behavior (>= MIN_VERSION): the filter is honored and a section
 * receives only its own rows.
 *
 * This is why the gate exists rather than shipping gateless. The
 * "when a gate is unnecessary" rule in `docs/BACKWARDS_COMPAT.md` requires
 * an older assistant to 404 into exactly the feature-off state; here it
 * answers 200 with a superset, which renders as a plausible-looking but
 * wrong section. Silent, and worse than the feature being absent. Sections
 * fall back to the conversations they are handed, which is what they used
 * before this filter existed and what any assistant understands.
 *
 * Scoped to the owning assistant via `useAssistantScopedSupports` (see its
 * JSDoc in `./utils.ts` for the atomic version+owner snapshot). The unscoped
 * check is not safe here: the section query is keyed by `assistantId`, and
 * across an assistant switch the identity store still holds the outgoing
 * assistant's version. An unscoped gate would read `true` from the old
 * assistant's version while the query is already fetching for the incoming
 * one, send `groupId` to an assistant that ignores it, and land that
 * unfiltered list in the new assistant's section cache. That is precisely
 * the failure this gate exists to prevent, and one React Query would keep
 * serving as last-successful data until something invalidated it.
 *
 * MIN_VERSION names the next scheduled cut from main (the assistant is on
 * 0.11.2 as this lands). A hotfix release branches from the latest release
 * tag instead, so a hotfix that claims this version number would NOT carry
 * the feature; if that happens, retarget this gate to the next scheduled
 * cut's number.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.3";

/**
 * Returns `true` when the assistant that owns the sidebar
 * (`ownerAssistantId`) filters the conversation list by group. Subscribes to
 * the identity store so consumers re-render when the version crosses
 * `MIN_VERSION`; conservative `false` while the version is unknown and on any
 * owner mismatch, which keeps a section query idle rather than rendering an
 * unfiltered list as one section.
 */
export function useSupportsGroupFilter(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
