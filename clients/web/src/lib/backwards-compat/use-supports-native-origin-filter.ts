/**
 * Backwards-compat gate: `originChannel=vellum` matching unattributed rows.
 *
 * Old behavior (< MIN_VERSION): the daemon compiles `originChannel` to a
 * strict equality, so `vellum` matches only rows explicitly stamped
 * `'vellum'`. `origin_channel` is deliberately NULL at insert (an inbound
 * message claims the conversation for its own channel, and migration 288
 * settles the unclaimed ones at daemon startup), so between one boot and the
 * next most rows carry NULL and the request answers 200 with a fraction of
 * the Chats section. Silent, and plausible-looking: a Chats card holding a
 * handful of rows reads as a quiet account, not as a broken filter.
 *
 * New behavior (>= MIN_VERSION): `vellum` matches NULL as well, so the Chats
 * card in Grouped view receives everything no channel claimed.
 *
 * This is a separate gate from {@link useSupportsGroupFilter} rather than a
 * bump of it. They are two server capabilities that shipped in two commits,
 * and folding them together would take section filtering away from every
 * assistant in between, which has the `groupId` filter and uses it correctly.
 * Below this gate the Chats section keeps deriving its rows from the loaded
 * list, exactly as it did before.
 *
 * Scoped to the owning assistant via `useAssistantScopedSupports`, for the
 * same reason the group-filter gate is: the section query is keyed by
 * `assistantId`, and across a switch the identity store still holds the
 * outgoing assistant's version. An unscoped gate would authorize the filtered
 * fetch against the incoming assistant and land a short list in its cache,
 * which React Query would keep serving as last-successful data.
 *
 * MIN_VERSION is the dev floor of the assistant-side commit (ef06e94,
 * 2026-08-07T02:22:14Z) rather than a predicted release number. v0.11.2 was
 * tagged 2026-08-04, so this sits mid dev window: naming a release would
 * either guess wrong or leave dogfooders dark until the cut. `versionSupports`
 * compares base versions first, so every later release satisfies this floor
 * whatever it is numbered, and dev builds cut from main after that timestamp
 * read as supported.
 *
 * The floor is strictly later than `use-supports-group-filter`'s on the same
 * base, so anything passing this gate also passes that one.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.2-dev.202608070222.ef06e94";

/**
 * Returns `true` when the assistant that owns the sidebar
 * (`ownerAssistantId`) treats an unattributed conversation as native.
 * Conservative `false` while the version is unknown and on any owner
 * mismatch, which keeps the Chats section on its derived rows rather than
 * showing a filtered subset of itself.
 */
export function useSupportsNativeOriginFilter(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
