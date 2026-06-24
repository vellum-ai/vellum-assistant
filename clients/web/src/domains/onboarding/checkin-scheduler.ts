/**
 * Schedules the "Day 2 Check-in" calendar event the moment the user grants
 * Google Calendar access on the check-in onboarding page.
 *
 * Programmatic flow: rather than minting a conversation and asking the
 * assistant to book the slot in natural language, this calls a dedicated
 * daemon endpoint that resolves the user's calendar, finds the first open
 * 15-minute slot tomorrow afternoon (12pm–5pm, widening to 8am–8pm if booked),
 * and creates the event server-side with the locked title + HTML description.
 *
 * Best-effort and fire-and-forget: a failure here must not block the
 * onboarding handoff, so every error is swallowed and surfaced only via the
 * returned boolean. The endpoint itself returns `scheduled: false` (not an
 * error) when no calendar is connected or the calendar scope wasn't granted.
 */

import { onboardingCheckinPost } from "@/generated/daemon/sdk.gen";

export interface ScheduleCheckinOptions {
  assistantId: string;
  userName?: string;
  assistantName?: string;
}

/**
 * Book the Day 2 Check-in event. Returns `true` when an event was created,
 * `false` otherwise (no calendar connected, scope not granted, or any error —
 * all treated identically as "best-effort, carry on").
 */
export async function scheduleCheckin({
  assistantId,
  userName,
  assistantName,
}: ScheduleCheckinOptions): Promise<boolean> {
  try {
    // Carry the browser timezone so "tomorrow" and the 12pm–5pm window resolve
    // to the user's local clock when the daemon books the slot. The daemon
    // falls back to its own timezone cascade when this is absent.
    let timezone: string | undefined;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      timezone = undefined;
    }

    const result = await onboardingCheckinPost({
      path: { assistant_id: assistantId },
      body: {
        userName: userName?.trim() || undefined,
        assistantName: assistantName?.trim() || undefined,
        timezone,
      },
      throwOnError: false,
    });

    return result.response?.ok === true && result.data?.scheduled === true;
  } catch {
    return false;
  }
}
