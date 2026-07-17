/**
 * Transport-agnostic route definitions for live-voice preflight.
 *
 * POST /v1/live-voice/preflight — ensure managed-speech defaulting has run,
 * then report whether the daemon can run both audio legs of a live voice
 * session. Lets the web client verify voice is configured BEFORE opening the
 * voice-room WebSocket, instead of opening it and reacting to an error frame.
 */

import { z } from "zod";

import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleLiveVoicePreflight() {
  const { maybeDefaultSpeechToManaged } =
    await import("../../config/managed-speech-defaults.js");
  const { resolveLiveVoiceCredentialReadiness } =
    await import("../../live-voice/live-voice-credential-preflight.js");

  await maybeDefaultSpeechToManaged();
  return resolveLiveVoiceCredentialReadiness();
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "live_voice_preflight_post",
    endpoint: "live-voice/preflight",
    method: "POST",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Live voice preflight",
    description:
      "Ensure managed speech defaulting has run, then report whether live voice can start.",
    tags: ["live-voice"],
    responseBody: z.object({
      status: z.enum(["ready", "not-ready"]),
      missing: z
        .array(
          z.object({
            kind: z.enum(["stt", "tts"]),
            providerId: z.string(),
            reason: z.string(),
          }),
        )
        .optional(),
      userMessage: z.string().optional(),
    }),
    handler: handleLiveVoicePreflight,
  },
];
