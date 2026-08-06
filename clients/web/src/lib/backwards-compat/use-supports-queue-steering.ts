/**
 * Backwards-compat gate: the "Push to agent" steer button on queued
 * messages.
 *
 * Vellum Assistant 0.8.4 added `POST /v1/messages/queued/:id/steer` (the
 * endpoint that promotes a queued message to the head of the queue and
 * aborts the in-flight generation; PR #31307). Older assistants 404 that
 * route, so the web app hides the steer arrow on queued-message rows —
 * the queue drawer renders with only the edit and cancel affordances, as
 * it does today, with no error surfaced.
 *
 * This is a write action: the endpoint aborts the assistant's live
 * generation. It gates inside `queued-messages-drawer.tsx`, the only
 * render site of the steer button. A render hook (not the
 * `assistantSupports` snapshot) so the button appears the moment the
 * version hydrates.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.8.4";

export function useSupportsQueueSteering(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
