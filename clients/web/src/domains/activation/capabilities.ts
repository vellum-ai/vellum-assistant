/**
 * Which `requires` tags a catalog task may carry, and whether each one is
 * currently answerable.
 *
 * A tag hides a row whose prerequisite is missing, so the checklist never
 * offers "sweep your inbox" to someone with no inbox connected. It is a
 * nicety, not access control: the gate fails open (every tag counts as
 * available) whenever no live signal answers it, because showing an extra row
 * is a much smaller cost than hiding one the user could have done.
 *
 * The rule is the same on every surface, and this is the one file that states
 * it: a task whose prerequisite is missing is skipped by the modal's rows, by
 * the Inspiration List, and by anything counting either. A list's three
 * starters carry no prerequisite at all (frozen by `catalog.test.ts`), so the
 * "n of 3" the pill reports and the all-done check that retires the checklist
 * count the same starters the modal draws without resolving a signal of their
 * own.
 */

import { useMemo } from "react";

import {
  useActivationList,
  type ActivationList,
  type ActivationTask,
} from "./catalog";

/**
 * The tags the catalog uses. Every one of them is currently unconditional,
 * each for its own reason:
 *
 * - `email` and `calendar`: no provider-agnostic connection signal reaches
 *   this client. The daemon's home-state capability tiers
 *   (`GET /v1/home/state`) are the closest thing, and they are projected only
 *   for Google connections, so gating on them would hide four rows from every
 *   Outlook and IMAP user. The platform's OAuth connections list is
 *   platform-hosted only and keyed by provider, so it misses IMAP too. Until
 *   the daemon publishes "an inbox is connected" and "a calendar is
 *   connected" without naming a provider, these fail open.
 * - `image-generation`: no negative signal exists. Image generation is served
 *   by the managed provider on every assistant unless the user replaces it in
 *   settings, and a configured replacement is still image generation.
 * - `shopping`: likewise. Shopping tasks run through browsing and skills,
 *   which every assistant has.
 *
 * The tags stay in the content and in this list so a signal can be wired in
 * without a content change.
 */
export const ACTIVATION_CAPABILITY_TAGS = [
  "email",
  "calendar",
  "image-generation",
  "shopping",
] as const;

export type ActivationCapabilityTag =
  (typeof ACTIVATION_CAPABILITY_TAGS)[number];

/** Whether a tag is one this build knows how to answer for. */
export function isKnownCapabilityTag(
  tag: string,
): tag is ActivationCapabilityTag {
  return (ACTIVATION_CAPABILITY_TAGS as readonly string[]).includes(tag);
}

/**
 * The capability tags currently available.
 *
 * Everything not gated by a live signal is included unconditionally, so a
 * caller can answer a row with a plain set membership test and never has to
 * distinguish "unknown tag" from "available tag".
 */
const AVAILABLE_CAPABILITY_TAGS: ReadonlySet<string> = new Set(
  ACTIVATION_CAPABILITY_TAGS,
);

/**
 * Whether a task's prerequisites are met. A task with no `requires` always
 * passes, and so does one requiring a tag this build does not know.
 */
function taskIsAvailable(
  task: Pick<ActivationTask, "requires">,
  availableTags: ReadonlySet<string>,
): boolean {
  return (task.requires ?? []).every(
    (tag) => !isKnownCapabilityTag(tag) || availableTags.has(tag),
  );
}

/**
 * The tasks of `listId` the user can actually do, starters and items kept
 * apart because the surfaces treat them differently.
 *
 * Every surface that renders catalog tasks reads them from here, so none can
 * offer a row another one hides.
 */
export function useAvailableActivationList(listId: string): ActivationList {
  const { starters, items } = useActivationList(listId);
  return useMemo(
    () => ({
      starters: starters.filter((task) =>
        taskIsAvailable(task, AVAILABLE_CAPABILITY_TAGS),
      ),
      items: items.filter((task) =>
        taskIsAvailable(task, AVAILABLE_CAPABILITY_TAGS),
      ),
    }),
    [items, starters],
  );
}
