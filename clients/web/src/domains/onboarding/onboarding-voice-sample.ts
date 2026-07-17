/**
 * Synthesizes a short sample of the assistant's voice for the onboarding
 * "Hear my voice" audition.
 *
 * SPIKE — research-onboarding flow (voice-mode gated).
 *
 * Hits the assistant runtime's TTS synthesize endpoint through the daemon SDK
 * (forwarded to the self-hosted gateway, so it works locally). It uses whatever
 * TTS provider the assistant is configured with — which for onboarding assistants
 * is the default Vellum managed voice (managed → Deepgram with a preselected
 * voice), so no provider API key is needed in the browser and the sample matches
 * what the assistant will actually sound like.
 *
 * Returns the audio blob, or null on any failure (assistant not ready, TTS
 * unavailable, network) — the caller decides how to surface that.
 */

import { ttsSynthesizePost } from "@/generated/daemon/sdk.gen";

export async function synthesizeManagedVoiceSample(
  assistantId: string,
  text: string,
): Promise<Blob | null> {
  try {
    const { data, error, response } = await ttsSynthesizePost({
      path: { assistant_id: assistantId },
      body: { text },
      parseAs: "blob",
      throwOnError: false,
    });
    if (error || !response?.ok || !data) return null;
    return data as Blob;
  } catch {
    return null;
  }
}
