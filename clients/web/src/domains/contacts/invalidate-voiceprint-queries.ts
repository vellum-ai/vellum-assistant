import type { QueryClient } from "@tanstack/react-query";

/**
 * Query key for one contact's voice profiles.
 *
 * Owned here rather than built at the call site so the card that reads it and
 * the sync consumer that invalidates it cannot drift apart.
 */
export function contactVoiceprintsQueryKey(
  assistantId: string,
  contactId: string,
): readonly unknown[] {
  return ["contact-voiceprints", assistantId, contactId];
}

/** Prefix matching every contact's voice profiles for one assistant. */
export function contactVoiceprintsQueryKeyPrefix(
  assistantId: string,
): readonly unknown[] {
  return ["contact-voiceprints", assistantId];
}

/**
 * Invalidate the voice profile queries an enroll / relabel / delete can stale.
 *
 * The `contacts:voiceprints` tag is deliberately not per-contact, so this
 * invalidates every cached contact's profiles for the assistant: any of them
 * may have changed on another client, and TanStack refetches only the ones
 * with a live observer.
 *
 * `refetchType` defaults to TanStack's own default: observed queries refetch
 * now, unobserved ones only go stale. Pass `"none"` to mark stale without
 * issuing any request.
 */
export function invalidateVoiceprintQueries(
  queryClient: QueryClient,
  assistantId: string,
  refetchType: "active" | "none" = "active",
): void {
  void queryClient.invalidateQueries({
    queryKey: contactVoiceprintsQueryKeyPrefix(assistantId),
    refetchType,
  });
}
