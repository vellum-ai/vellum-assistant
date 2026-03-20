/**
 * HTTP route handler for serving synthesized TTS audio.
 *
 * GET /v1/audio/:audioId — retrieve a previously stored audio segment.
 *
 * This endpoint is unauthenticated because Twilio fetches audio URLs
 * directly; the audioId itself is an unguessable UUID that acts as a
 * capability token.
 */

import { getAudio } from "../../calls/audio-store.js";
import { httpError } from "../http-errors.js";

/**
 * Handle GET /v1/audio/:audioId.
 *
 * Returns the audio buffer with its stored Content-Type on hit,
 * or a 404 when the audioId is unknown or expired.
 */
export function handleGetAudio(audioId: string): Response {
  const entry = getAudio(audioId);
  if (!entry) {
    return httpError("NOT_FOUND", "Audio not found", 404);
  }
  return new Response(new Uint8Array(entry.buffer), {
    status: 200,
    headers: { "Content-Type": entry.contentType },
  });
}
