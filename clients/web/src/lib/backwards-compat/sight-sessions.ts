import type { LiveVoiceReadyServerFrame } from "@/domains/chat/voice/live-voice/protocol";

/** Whether this connected assistant negotiated camera-run lifecycle frames. */
export function supportsSightSessions(
  ready: Pick<LiveVoiceReadyServerFrame, "sightSessions">,
): boolean {
  return ready.sightSessions === true;
}
