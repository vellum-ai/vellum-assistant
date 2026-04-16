/**
 * meet_speak / meet_cancel_speak tools — synthesize speech into an active
 * Meet call and (voluntarily) cut it off.
 *
 * Paired with {@link ./meet-join-tool.ts meet_join} and
 * {@link ./meet-leave-tool.ts meet_leave}: all four tools are first-party
 * because they command the in-process `MeetSessionManager` (audio bridge,
 * per-meeting bearer tokens, container lifecycle). See the rationale comment
 * at the top of `meet-join-tool.ts` — keeping the speech control surface
 * in-process avoids a new HTTP API that mirrors the same session-manager
 * state.
 *
 * `text` is capped at 600 characters as a *soft* upper bound: long-form
 * answers should stay in chat where the participant can re-read them.
 * The bot itself does not enforce a length, but pushing multi-paragraph
 * essays through synthesis costs latency and turns the assistant into a
 * monologue — so we refuse here and let the agent re-plan.
 */

import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../../assistant/src/config/assistant-feature-flags.js";
import { getConfig } from "../../../assistant/src/config/loader.js";
import { RiskLevel } from "../../../assistant/src/permissions/types.js";
import type { ToolDefinition } from "../../../assistant/src/providers/types.js";
import type {
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../../../assistant/src/tools/types.js";
import { getLogger } from "../../../assistant/src/util/logger.js";
import {
  MeetSessionManager,
  MeetSessionNotFoundError,
} from "../daemon/session-manager.js";
import { MEET_FLAG_KEY } from "./meet-join-tool.js";

const log = getLogger("meet-speak-tool");

/**
 * Soft cap on the synthesized text length. Anything longer should be sent
 * as a chat message via {@link ./meet-send-chat-tool.ts meet_send_chat}
 * instead of monopolizing the audio channel.
 */
export const MEET_SPEAK_MAX_TEXT_LENGTH = 600;

const MeetSpeakInputSchema = z.object({
  meetingId: z.string().trim().min(1).optional(),
  text: z
    .string()
    .min(1, "text is required")
    .max(
      MEET_SPEAK_MAX_TEXT_LENGTH,
      `text exceeds the ${MEET_SPEAK_MAX_TEXT_LENGTH}-character soft limit — send long replies via meet_send_chat instead`,
    ),
  voice: z.string().trim().min(1).optional(),
});

export type MeetSpeakInput = z.infer<typeof MeetSpeakInputSchema>;

const MeetCancelSpeakInputSchema = z.object({
  meetingId: z.string().trim().min(1).optional(),
});

export type MeetCancelSpeakInput = z.infer<typeof MeetCancelSpeakInputSchema>;

/**
 * Resolve the target meetingId from caller input + active sessions.
 * Returns `{ ok: true, meetingId }` when a single target is determined,
 * or `{ ok: false, content }` carrying the error string the tool should
 * surface verbatim. Mirrors the disambiguation logic in `meet_send_chat`
 * and `meet_leave` so the four tools behave consistently when called
 * without an explicit meetingId.
 */
function resolveTargetMeetingId(
  explicitId: string | undefined,
): { ok: true; meetingId: string } | { ok: false; content: string } {
  if (explicitId) {
    return { ok: true, meetingId: explicitId };
  }
  const active = MeetSessionManager.activeSessions();
  if (active.length === 0) {
    return { ok: false, content: "Error: no active Meet session." };
  }
  if (active.length > 1) {
    const ids = active.map((s) => s.meetingId).join(", ");
    return {
      ok: false,
      content: `Error: multiple active Meet sessions (${ids}). Pass meetingId explicitly.`,
    };
  }
  return { ok: true, meetingId: active[0].meetingId };
}

class MeetSpeakTool implements Tool {
  name = "meet_speak";
  description =
    "Speak synthesized audio into an active Google Meet call. Use this to reply out loud during a meeting; for long-form answers prefer meet_send_chat. When exactly one Meet session is active, meetingId may be omitted and the active session is targeted automatically; otherwise pass the specific meetingId returned by meet_join.";
  category = "meet";
  // Low: consent for audio output is established meeting-wide by `meet_join`
  // (High) and the join-consent message announcing the bot. Speaking within
  // that bounded session is within the user's expressed consent envelope,
  // and proactive-speech wakes run on client-less conversations where a
  // Medium-risk approval prompt would hang forever. Aligns with `meet_leave`
  // and `meet_send_chat` (also Low).
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          meetingId: {
            type: "string",
            description:
              "The id of the meeting to speak into, as returned by meet_join. Optional when exactly one session is active.",
          },
          text: {
            type: "string",
            description: `The text to synthesize and play. Keep it conversational and under ${MEET_SPEAK_MAX_TEXT_LENGTH} characters — longer replies should be sent via meet_send_chat.`,
          },
          voice: {
            type: "string",
            description:
              "Optional provider-specific voice identifier. Falls back to the configured default voice when omitted.",
          },
        },
        required: ["text"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // 1. Feature-flag gate — symmetric with the other meet_* tools.
    const config = getConfig();
    if (!isAssistantFeatureFlagEnabled(MEET_FLAG_KEY, config)) {
      return {
        content:
          "Error: the meet feature is disabled. Enable the `meet` feature flag to speak in Google Meet calls.",
        isError: true,
      };
    }

    // 2. Input validation.
    const parsed = MeetSpeakInputSchema.safeParse(input);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "invalid meet_speak input";
      return { content: `Error: ${message}`, isError: true };
    }
    const { meetingId: explicitId, text, voice } = parsed.data;

    // 3. Disambiguate target session when no id is supplied.
    const target = resolveTargetMeetingId(explicitId);
    if (!target.ok) {
      return { content: target.content, isError: true };
    }
    const targetMeetingId = target.meetingId;

    // 4. Delegate.
    try {
      const result = await MeetSessionManager.speak(targetMeetingId, {
        text,
        voice,
      });
      log.info(
        {
          meetingId: targetMeetingId,
          streamId: result.streamId,
          textLength: text.length,
          voice: voice ?? "default",
        },
        "meet_speak tool started a TTS stream",
      );
      return {
        content: JSON.stringify({
          meetingId: targetMeetingId,
          streamId: result.streamId,
        }),
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, meetingId: targetMeetingId, textLength: text.length },
        "meet_speak tool failed",
      );
      if (err instanceof MeetSessionNotFoundError) {
        return {
          content: `Error: no active Meet session for meetingId=${targetMeetingId}.`,
          isError: true,
        };
      }
      return {
        content: `Error: failed to speak into Meet — ${message}`,
        isError: true,
      };
    }
  }
}

class MeetCancelSpeakTool implements Tool {
  name = "meet_cancel_speak";
  description =
    "Cancel any in-flight synthesized speech in an active Google Meet call so the assistant can voluntarily stop talking (e.g. when interrupted by a participant). When exactly one Meet session is active, meetingId may be omitted and the active session is targeted automatically; otherwise pass the specific meetingId returned by meet_join.";
  category = "meet";
  // Low: cancelling the assistant's own audio output is strictly less
  // invasive than speaking — no new sound is emitted, and idempotent
  // when nothing is currently playing.
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          meetingId: {
            type: "string",
            description:
              "The id of the meeting whose in-flight speech should be cancelled. Optional when exactly one session is active.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // 1. Feature-flag gate.
    const config = getConfig();
    if (!isAssistantFeatureFlagEnabled(MEET_FLAG_KEY, config)) {
      return {
        content:
          "Error: the meet feature is disabled. Enable the `meet` feature flag to manage Google Meet calls.",
        isError: true,
      };
    }

    // 2. Input validation. All fields are optional so a bare `{}` is valid;
    //    Zod still catches wrong-type submissions.
    const parsed = MeetCancelSpeakInputSchema.safeParse(input);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "invalid meet_cancel_speak input";
      return { content: `Error: ${message}`, isError: true };
    }
    const { meetingId: explicitId } = parsed.data;

    // 3. Disambiguate target session.
    const target = resolveTargetMeetingId(explicitId);
    if (!target.ok) {
      return { content: target.content, isError: true };
    }
    const targetMeetingId = target.meetingId;

    // 4. Delegate. `cancelSpeak` is idempotent when nothing is in flight.
    try {
      await MeetSessionManager.cancelSpeak(targetMeetingId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, meetingId: targetMeetingId },
        "meet_cancel_speak tool failed",
      );
      if (err instanceof MeetSessionNotFoundError) {
        return {
          content: `Error: no active Meet session for meetingId=${targetMeetingId}.`,
          isError: true,
        };
      }
      return {
        content: `Error: failed to cancel Meet speech — ${message}`,
        isError: true,
      };
    }

    return {
      content: JSON.stringify({
        cancelled: true,
        meetingId: targetMeetingId,
      }),
      isError: false,
    };
  }
}

/** Exported singletons so the tool registry can re-register after test resets. */
export const meetSpeakTool = new MeetSpeakTool();
export const meetCancelSpeakTool = new MeetCancelSpeakTool();
