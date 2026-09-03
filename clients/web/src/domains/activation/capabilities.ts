/**
 * Which `requires` tags a catalog task may carry, and how each one maps onto a
 * signal the daemon already publishes.
 *
 * A tag hides a row whose prerequisite is missing, so the checklist never
 * offers "sweep your inbox" to someone with no inbox connected. It is a
 * nicety, not access control: the gate fails open (every tag counts as
 * available) while the signal is loading, when the read fails, and for any tag
 * this build does not know, because showing an extra row is a much smaller
 * cost than hiding one the user could have done.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { homeStateGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import type { ActivationTask } from "./catalog";

/**
 * The tags the catalog uses, each with the signal behind it:
 *
 * - `email`: the daemon's `email` capability reports `unlocked` once an
 *   account with mail access is connected (`GET /v1/home/state`, projected in
 *   `assistant/src/home/relationship-state-writer.ts` from the OAuth
 *   connection store).
 * - `calendar`: the daemon's `calendar` capability, unlocked by the same
 *   connection store once a calendar account is connected.
 * - `image-generation`: no negative signal exists. Image generation is served
 *   by the managed provider on every assistant unless the user replaces it in
 *   settings, and a configured replacement is still image generation. The tag
 *   is carried by the catalog so a signal can be wired in without a content
 *   change; until then it is always available.
 * - `shopping`: likewise. Shopping tasks run through browsing and skills,
 *   which every assistant has.
 */
export const ACTIVATION_CAPABILITY_TAGS = [
  "email",
  "calendar",
  "image-generation",
  "shopping",
] as const;

export type ActivationCapabilityTag =
  (typeof ACTIVATION_CAPABILITY_TAGS)[number];

/**
 * Tags answered by the daemon's home-state capability list, where the tag is
 * also the capability id (`assistant/src/home/relationship-state.ts`). Every
 * other tag is unconditionally available.
 */
const HOME_STATE_TAGS: readonly string[] = ["email", "calendar"];

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
export function useAvailableCapabilityTags(): ReadonlySet<string> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const isOrgReady = useIsOrgReady();

  const { data: unlockedIds } = useQuery({
    ...homeStateGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: assistantId != null && isOrgReady,
    select: (data) =>
      new Set(
        data.capabilities
          .filter((capability) => capability.tier === "unlocked")
          .map((capability) => capability.id),
      ),
  });

  return useMemo(
    () =>
      new Set(
        ACTIVATION_CAPABILITY_TAGS.filter(
          (tag) =>
            !HOME_STATE_TAGS.includes(tag) ||
            // Fail open until the read lands: `undefined` is "not known yet",
            // not "not connected".
            !unlockedIds ||
            unlockedIds.has(tag),
        ),
      ),
    [unlockedIds],
  );
}

/**
 * Whether a task's prerequisites are met. A task with no `requires` always
 * passes, and so does one requiring a tag this build does not know.
 */
export function taskIsAvailable(
  task: Pick<ActivationTask, "requires">,
  availableTags: ReadonlySet<string>,
): boolean {
  return (task.requires ?? []).every(
    (tag) => !isKnownCapabilityTag(tag) || availableTags.has(tag),
  );
}
