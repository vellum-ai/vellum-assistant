/**
 * Fires the "Day 2 Check-in" prompt into a dedicated, fresh conversation the
 * moment the user grants Google Calendar access on the check-in onboarding
 * page.
 *
 * SPIKE — checkin-onboarding flow.
 *
 * This is intentionally a SEPARATE conversation from the main onboarding
 * handoff (which carries the research prompt): we explicitly mint one via
 * `conversationsPost` and post the check-in prompt into it, rather than
 * server-minting by omitting the conversation id, so the scheduling turn can
 * never collide with the onboarding opener.
 *
 * Best-effort and fire-and-forget: a failure here must not block the
 * onboarding handoff, so every error is swallowed and surfaced only via the
 * returned boolean. Talks to the daemon through the generated SDK directly —
 * `@/domains/chat/api/messages` lives in another domain and is import-banned
 * from onboarding.
 */

import {
  conversationsPost,
  messagesPost,
} from "@/generated/daemon/sdk.gen";
import type { MessagesPostData } from "@/generated/daemon/types.gen";

import { buildCheckinPrompt } from "@/domains/onboarding/checkin-prompt";

export interface ScheduleCheckinOptions {
  assistantId: string;
  userName?: string;
  assistantName?: string;
}

/**
 * Create a dedicated conversation and post the Day 2 Check-in prompt into it.
 * Returns the new conversation id on success, or `null` if anything failed
 * (the caller treats this as "best-effort, carry on").
 */
export async function scheduleCheckin({
  assistantId,
  userName,
  assistantName,
}: ScheduleCheckinOptions): Promise<string | null> {
  try {
    const conversation = await conversationsPost({
      path: { assistant_id: assistantId },
      body: { conversationType: "standard" },
      throwOnError: false,
    });
    const conversationId = conversation.data?.id;
    if (!conversation.response?.ok || !conversationId) {
      return null;
    }

    const body: MessagesPostData["body"] = {
      conversationId,
      content: buildCheckinPrompt({ userName, assistantName }),
      sourceChannel: "vellum",
      interface: "vellum",
      clientMessageId: crypto.randomUUID(),
    };
    // Carry the browser timezone so "tomorrow"/"evening" resolve to the user's
    // local clock when the assistant books the slot. Mirrors the field
    // `postChatMessage` sends; computed inline to avoid a cross-domain import.
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) body.clientTimezone = tz;
    } catch {
      // Intl unavailable — daemon falls back to its own timezone cascade.
    }

    const message = await messagesPost({
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
    if (!message.response?.ok) {
      return null;
    }
    return conversationId;
  } catch {
    return null;
  }
}
