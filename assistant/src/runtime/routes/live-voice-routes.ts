/**
 * Transport-agnostic route definitions for live-voice preflight.
 *
 * POST /v1/live-voice/preflight — ensure managed-speech defaulting has run,
 * then report whether the daemon can run both audio legs of a live voice
 * session. Lets the web client verify voice is configured BEFORE opening the
 * voice-room WebSocket, instead of opening it and reacting to an error frame.
 *
 * POST /v1/live-voice/session/end releases whatever session holds the
 * daemon's single live-voice slot. The out-of-band half of session closure:
 * the in-band `end` frame needs a working transport, and the case that needs
 * ending most is the one where the transport is already gone.
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

async function handleLiveVoiceSessionEnd() {
  const { getLiveVoiceSessionManager } =
    await import("../../live-voice/live-voice-manager.js");

  const result = await getLiveVoiceSessionManager().endActiveSession();
  return {
    ended: result.released,
    sessionId: result.released ? result.sessionId : null,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "live_voice_preflight_post",
    endpoint: "live-voice/preflight",
    method: "POST",
    // Requires settings.write, not a read scope: the handler runs
    // maybeDefaultSpeechToManaged(), which can persist config changes
    // (switching services.stt/tts.provider to "vellum"). This matches the
    // secret/settings config writers, which all require settings.write.
    policy: {
      requiredScopes: ["settings.write"],
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
  {
    operationId: "live_voice_session_end_post",
    endpoint: "live-voice/session/end",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "End the active live voice session",
    description:
      "Release the assistant's single live-voice session slot, whichever client holds it. Reports whether a session was actually ended; a slot already tearing down reports false, since that teardown releases it on its own.",
    tags: ["live-voice"],
    responseBody: z.object({
      ended: z.boolean(),
      sessionId: z.string().nullable(),
    }),
    handler: handleLiveVoiceSessionEnd,
  },
];
