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

export function readCompletionContext(
  event: CompletionEvent,
): CompletionContext | undefined {
  if (event.sourceEventName !== "activity.complete") {
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
  if (completion && completion.recipientPrincipalId !== guardianPrincipalId) {
    return undefined;
  }
  return guardianPrincipalId;
}

/** Local previews and explicitly owned mobile completions require a recipient. */
export function isCompletionRecipientUnavailable(
  event: CompletionEvent,
  destination: ChannelDestination,
): boolean {
  const requiresRecipient =
    (destination.channel === "vellum" && isCompletionNotification(event)) ||
    (destination.channel === "platform" &&
      readCompletionContext(event) !== undefined);
  return requiresRecipient && !resolveCompletionRecipient(event, destination);
}
