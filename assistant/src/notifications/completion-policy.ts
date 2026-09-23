import { z } from "zod";

import type { ChannelDestination } from "./types.js";
import type { Urgency } from "./urgency.js";

export const CompletionContextSchema = z.object({
  workId: z.string().trim().min(1),
  conversationId: z.string().trim().min(1),
  recipientPrincipalId: z.string().trim().min(1),
  owner: z.literal("parent_continuation"),
});

export type CompletionContext = z.infer<typeof CompletionContextSchema>;

interface CompletionEvent {
  sourceEventName: string;
  contextPayload?: Record<string, unknown>;
}

/** Declared ownership stays private even when the completion payload is malformed. */
export function hasCompletionOwnership(event: CompletionEvent): boolean {
  return (
    event.sourceEventName === "activity.complete" &&
    Object.prototype.hasOwnProperty.call(
      event.contextPayload ?? {},
      "completion",
    )
  );
}

export function readCompletionContext(
  event: CompletionEvent,
): CompletionContext | undefined {
  if (!hasCompletionOwnership(event)) {
    return undefined;
  }
  const parsed = CompletionContextSchema.safeParse(
    event.contextPayload?.completion,
  );
  return parsed.success ? parsed.data : undefined;
}

export function isCompletionNotification(event: CompletionEvent): boolean {
  return (
    event.sourceEventName === "chat.assistant_reply" ||
    event.sourceEventName === "schedule.result" ||
    readCompletionContext(event) !== undefined
  );
}

export function hasPersistedCompletionResult(event: CompletionEvent): boolean {
  return (
    event.sourceEventName === "chat.assistant_reply" ||
    readCompletionContext(event) !== undefined
  );
}

export function notificationConversationId(
  event: CompletionEvent & { sourceContextId?: string },
): string | undefined {
  return readCompletionContext(event)?.conversationId ?? event.sourceContextId;
}

/** Completion presentation is independent of urgency and channel routing. */
export function isLocalNotificationSilent(
  event: CompletionEvent & { urgency: Urgency },
): boolean {
  if (event.contextPayload?.quiet === true) {
    return true;
  }
  return (
    !isCompletionNotification(event) &&
    event.urgency !== "high" &&
    event.urgency !== "critical"
  );
}

/** A completion preview may only reach the currently bound recipient. */
export function resolveCompletionRecipient(
  event: CompletionEvent,
  destination: ChannelDestination,
): string | undefined {
  const raw = destination.metadata?.guardianPrincipalId;
  const guardianPrincipalId = typeof raw === "string" ? raw.trim() : "";
  if (!guardianPrincipalId) {
    return undefined;
  }
  const completion = readCompletionContext(event);
  if (
    hasCompletionOwnership(event) &&
    completion?.recipientPrincipalId !== guardianPrincipalId
  ) {
    return undefined;
  }
  return guardianPrincipalId;
}

/** Owned completions require a matching local/mobile recipient; local previews require a recipient. */
export function isCompletionRecipientUnavailable(
  event: CompletionEvent,
  destination: ChannelDestination,
): boolean {
  const ownedCompletion = hasCompletionOwnership(event);
  if (
    ownedCompletion &&
    destination.channel !== "vellum" &&
    destination.channel !== "platform"
  ) {
    return true;
  }
  const requiresRecipient =
    ownedCompletion ||
    (destination.channel === "vellum" && isCompletionNotification(event));
  return requiresRecipient && !resolveCompletionRecipient(event, destination);
}
