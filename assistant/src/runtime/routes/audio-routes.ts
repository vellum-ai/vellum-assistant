/**
 * Route handler for serving synthesized TTS audio.
 *
 * GET /v1/audio/:audioId — retrieve a previously stored audio segment.
 *
 * This endpoint is unauthenticated because Twilio fetches audio URLs
 * directly; the audioId itself is an unguessable UUID that acts as a
 * capability token.
 */

import { getAudio } from "../../calls/audio-store.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Handle GET /v1/audio/:audioId.
 *
 * Returns the audio with its stored Content-Type. For complete audio,
 * returns a Uint8Array. For in-progress streaming entries, returns a
 * ReadableStream<Uint8Array>.
 */
function handleGetAudio({
  pathParams,
}: RouteHandlerArgs): Uint8Array | ReadableStream<Uint8Array> {
  const audioId = pathParams?.audioId;
  if (!audioId) {
    throw new NotFoundError("Audio not found");
  }

  const entry = getAudio(audioId);
  if (!entry) {
    throw new NotFoundError("Audio not found");
  }

  if (entry.type === "buffer") {
    return new Uint8Array(entry.buffer);
  }

  // Streaming — in-progress synthesis
  return entry.stream;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "audio_get",
    endpoint: "audio/:audioId",
    method: "GET",
    isPublic: true,
    summary: "Get audio segment",
    description:
      "Retrieve a previously stored audio segment by ID. " +
      "Unauthenticated — the audioId is an unguessable UUID capability token.",
    tags: ["audio"],
    responseHeaders: ({ pathParams }) => {
      const entry = pathParams?.audioId
        ? getAudio(pathParams.audioId)
        : undefined;
      const contentType = entry?.contentType ?? "application/octet-stream";
      const headers: Record<string, string> = {
        "Content-Type": contentType,
      };
      if (entry?.type === "buffer") {
        headers["Content-Length"] = entry.buffer.length.toString();
      }
      return headers;
    },
    handler: handleGetAudio,
  },
];
