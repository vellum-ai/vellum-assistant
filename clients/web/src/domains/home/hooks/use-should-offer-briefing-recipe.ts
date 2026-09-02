/**
 * Visibility for the notifications bell's briefing recipe card.
 *
 * The card advertises schedules, so it is aimed at the people who have not
 * adopted them: it appears only while the user has no schedule of their own.
 * Everything else the bell reports on (permission requests, replies that
 * arrived while the user was away, inbound channel requests, credential
 * alerts, heartbeat failures) posts without any schedule involved, so an empty
 * bell is never proof that nothing is set up. The card is an offer, not a
 * diagnosis.
 */
import { useQuery } from "@tanstack/react-query";

import {
  isLiveUserSchedule,
  schedulesListQueryOptions,
} from "@/utils/schedules";

/**
 * Decide whether the bell's empty state should offer the briefing recipe.
 *
 * `enabled` gates the schedules fetch. The bell renders in the top bar on
 * every route, so the caller passes `true` only while the empty state is
 * actually on screen; the query key is the one the Schedules page and the
 * bell's own entity-link resolver already use, so an open panel reads a warm
 * cache rather than issuing a second request.
 *
 * Fails closed on every state that is not a settled, empty answer. A card that
 * appeared while the list was still loading would have to be taken away again
 * the moment a schedule arrived, and a failed load says nothing about whether
 * the user has schedules, so neither state may show an advertisement.
 */
export function useShouldOfferBriefingRecipe(
  assistantId: string | null | undefined,
  enabled: boolean,
): boolean {
  // Also gated on the assistant, which resolves asynchronously and is null for
  // the first frames after a load. Without an assistant the options answer
  // with an empty list rather than a fetch, which would read as "no schedules"
  // and offer a recipe whose conversation has nothing to open against.
  // Disabled, the query reports pending, and pending never shows the card.
  const schedulesQuery = useQuery({
    ...schedulesListQueryOptions(assistantId ?? undefined),
    enabled: enabled && Boolean(assistantId),
  });

  const schedules = schedulesQuery.data;
  const hasSettledEmptyList =
    !schedulesQuery.isPending &&
    !schedulesQuery.isError &&
    schedules !== undefined &&
    !schedules.some(isLiveUserSchedule);

  // The assistant is re-checked here rather than left to the `enabled` flag
  // above. A disabled query still reports whatever its key already holds, and
  // the assistant-less key resolves to an empty list without a fetch, so the
  // answer states the requirement itself instead of resting on what happens to
  // be cached.
  return Boolean(assistantId) && hasSettledEmptyList;
}
