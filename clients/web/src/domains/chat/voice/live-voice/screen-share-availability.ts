import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { supportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";

/**
 * Whether the running call can be shown the screen: a session is up, on an
 * assistant that understands `sight_frame`, and it has not latched the frame
 * as unsupported.
 *
 * A snapshot, for the two callers that need the answer at a moment rather than
 * across a render: the companion mirror publishing what the surface may draw,
 * and the binding that decides whether the keyboard's share is worth arming.
 * `use-live-voice-screen-share.ts` runs the same conjunction through the hook
 * form, which is the same three terms subscribed to rather than read.
 */
export function liveVoiceCanBeShownTheScreen(): boolean {
  const session = useLiveVoiceStore.getState();
  return (
    isLiveVoiceSessionActive(session.state) &&
    !session.sightFramesUnsupported &&
    supportsSightStream(session.assistantId)
  );
}
