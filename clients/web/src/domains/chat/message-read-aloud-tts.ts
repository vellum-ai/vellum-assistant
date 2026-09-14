import { ttsSynthesizePost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

export type MessagePlaybackAudio =
  | { kind: "audio"; blob: Blob }
  | { kind: "unavailable" };

/**
 * Fetch spoken audio for a chat message from the assistant's TTS route.
 *
 * Returns `unavailable` when the assistant has no TTS provider, the route is
 * missing on an older assistant, or the request fails. Callers fall back to
 * the device's speech synthesizer so Read aloud is never a dead end.
 */
export async function synthesizeMessagePlayback(options: {
  assistantId: string;
  text: string;
  conversationId?: string | null;
}): Promise<MessagePlaybackAudio> {
  const { assistantId, text, conversationId } = options;
  try {
    const { data, error, response } = await ttsSynthesizePost({
      path: { assistant_id: assistantId },
      body: {
        text,
        ...(conversationId ? { conversationId } : {}),
      },
      parseAs: "blob",
      throwOnError: false,
    });
    if (response && !response.ok) {
      if (response.status !== 503 && response.status !== 404) {
        captureError(
          error ?? new Error(`TTS synthesize HTTP ${response.status}`),
          {
            context: "message-read-aloud",
            bestEffort: true,
          },
        );
      }
      return { kind: "unavailable" };
    }
    if (!(data instanceof Blob) || data.size === 0) {
      return { kind: "unavailable" };
    }
    const contentType = data.type.toLowerCase();
    if (contentType.includes("json") || contentType.startsWith("text/")) {
      return { kind: "unavailable" };
    }
    return { kind: "audio", blob: data };
  } catch (err) {
    captureError(err, {
      context: "message-read-aloud",
      bestEffort: true,
    });
    return { kind: "unavailable" };
  }
}
