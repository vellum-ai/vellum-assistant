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
 * Returns the audio with its stored Content-Type. For complete audio,
 * includes Content-Length for efficient playback. For in-progress
 * streaming entries, uses chunked transfer encoding.
 */
export function handleGetAudio(audioId: string): Response {
  const entry = getAudio(audioId);
  if (!entry) {
    return httpError("NOT_FOUND", "Audio not found", 404);
  }
  if (entry.type === "file") {
    return new Response(Bun.file(entry.filePath), {
      status: 200,
      headers: {
        "Content-Type": entry.contentType,
        "Content-Length": entry.sizeBytes.toString(),
      },
    });
  }
  // Streaming — Content-Length unknown, chunked transfer encoding
  return new Response(entry.stream, {
    status: 200,
    headers: { "Content-Type": entry.contentType },
  });
}
