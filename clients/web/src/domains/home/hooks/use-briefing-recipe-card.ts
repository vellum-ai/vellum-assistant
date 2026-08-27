/**
 * Visibility and dismissal for the notifications bell's briefing recipe card.
 *
 * The card advertises schedules, so it is aimed at the people who have not
 * adopted them: it appears only while the user has no schedule of their own,
 * and it stays gone once dismissed. Everything else the bell reports on
 * (permission requests, replies that arrived while the user was away, inbound
 * channel requests, credential alerts, heartbeat failures) posts without any
 * schedule involved, so an empty bell is never proof that nothing is set up.
 * The card is an offer, not a diagnosis.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  isLiveUserSchedule,
  schedulesListQueryOptions,
} from "@/utils/schedules";
import { createStorageAccessor } from "@/utils/typed-storage";

const DISMISSED_AT_KEY = "vellum:notificationsBell:briefingRecipeDismissedAt";

/**
 * When the user dismissed the card, in epoch ms. `0` means they have not.
 *
 * A timestamp rather than a bare boolean, following the tips store: it records
 * the same fact a boolean would while leaving room to reshow after some
 * interval later, which a boolean would need a storage migration to allow.
 *
 * User-scoped, so the logout sweep clears it. The dismissal is a statement by
 * a person ("stop offering me this"), not a property of the browser, so the
 * next person to sign in on a shared machine must not inherit it. That also
 * makes it the wrong thing to key per assistant: someone who has said no to
 * the offer has said no to it, and creating a second assistant is not a reason
 * to ask again.
 */
const briefingRecipeDismissedAtStorage = createStorageAccessor<number>({
  key: DISMISSED_AT_KEY,
  scope: "user",
  parse: (raw) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  },
  serialize: String,
  fallback: 0,
});

/**
 * Whether the dismissal can be read back at all.
 *
 * `localStorage` throws outright in a private window and under a policy that
 * blocks site data, and the accessor answers such a read with its fallback,
 * which is indistinguishable from never having been dismissed. On a device
 * like that the card would return on every load however many times it was
 * waved away, so an unreadable store counts as dismissed. That is the trade
 * the memory-graph intro makes for the same reason: under-showing an offer
 * costs less than nagging with a dismissal that cannot stick.
 */
function isDismissalReadable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    window.localStorage.getItem(DISMISSED_AT_KEY);
    return true;
  } catch {
    return false;
  }
}

export interface BriefingRecipeCard {
  /** Whether to render the card at all. */
  isVisible: boolean;
  /** Hide the card for good. */
  dismiss: () => void;
}

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
export function useBriefingRecipeCard(
  assistantId: string | null | undefined,
  enabled: boolean,
): BriefingRecipeCard {
  const dismissedAt = briefingRecipeDismissedAtStorage.useValue();

  // Also gated on the assistant, which resolves asynchronously and is null for
  // the first frames after a load. Without an assistant the options answer
  // with an empty list rather than a fetch, which would read as "no schedules"
  // and offer a recipe whose conversation has nothing to open against.
  // Disabled, the query reports pending, and pending never shows the card.
  const schedulesQuery = useQuery({
    ...schedulesListQueryOptions(assistantId ?? undefined),
    enabled: enabled && Boolean(assistantId),
  });

  const dismiss = useCallback(() => {
    briefingRecipeDismissedAtStorage.save(Date.now());
  }, []);

  const schedules = schedulesQuery.data;
  const hasSettledEmptyList =
    !schedulesQuery.isPending &&
    !schedulesQuery.isError &&
    schedules !== undefined &&
    !schedules.some(isLiveUserSchedule);

  // The assistant is re-checked here rather than left to the `enabled` flag
  // above. A disabled query still reports whatever its key already holds, and
  // the assistant-less key resolves to an empty list without a fetch, so the
  // visibility answer states the requirement itself instead of resting on what
  // happens to be cached.
  //
  // Ordered so the cheap reads settle it first: the bell re-renders with every
  // layout update, and `isDismissalReadable` touches storage, so that one runs
  // only in the state where its answer can still change the outcome.
  const isVisible =
    Boolean(assistantId) &&
    hasSettledEmptyList &&
    dismissedAt === 0 &&
    isDismissalReadable();

  return { isVisible, dismiss };
}
