import type { AssistantEvent } from "@vellumai/assistant-api";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { captureError } from "@/lib/sentry/capture-error";
import { handleScreenRecordingEvent } from "@/runtime/screen-recording";

type RecordingLifecycleEvent = Extract<
  AssistantEvent,
  {
    type:
      | "recording_start"
      | "recording_stop"
      | "recording_pause"
      | "recording_resume";
  }
>;

const isRecordingLifecycleEvent = (
  event: AssistantEvent,
): event is RecordingLifecycleEvent =>
  event.type === "recording_start" ||
  event.type === "recording_stop" ||
  event.type === "recording_pause" ||
  event.type === "recording_resume";

export function useScreenRecordingLifecycle(): void {
  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (!isRecordingLifecycleEvent(event)) {
      return;
    }
    void handleScreenRecordingEvent(event, envelope.sourceAssistantId).catch(
      (error) => {
        captureError(error, {
          context: "screen_recording_lifecycle",
          tags: { eventType: event.type },
        });
      },
    );
  });
}
