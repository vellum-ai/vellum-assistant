/**
 * meet_enable_avatar / meet_disable_avatar tools — toggle the bot's video
 * avatar inside an active Meet call.
 *
 * Paired with {@link ./meet-join-tool.ts meet_join} and the other
 * in-meeting verbs ({@link ./meet-send-chat-tool.ts meet_send_chat},
 * {@link ./meet-speak-tool.ts meet_speak}): all are first-party tools
 * because they command the in-process `MeetSessionManager` (per-meeting
 * bearer tokens, container lifecycle). See the rationale comment at the
 * top of `meet-join-tool.ts` — keeping the avatar control surface
 * in-process avoids a new HTTP API that mirrors the same session-manager
 * state.
 *
 * The SKILL.md "Video avatar" section (`skills/meet-join/SKILL.md`)
 * carries the canonical guidance on *when* to enable/disable — the tool
 * descriptions below are intentionally terse and defer to that section
 * rather than duplicating it, so the model's routing logic stays in one
 * place.
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
  MeetBotAvatarError,
  MeetSessionManager,
  MeetSessionNotFoundError,
  MeetSessionUnreachableError,
} from "../daemon/session-manager.js";
import { MEET_FLAG_KEY } from "./meet-join-tool.js";

const log = getLogger("meet-avatar-tool");

const MeetAvatarInputSchema = z.object({
  meetingId: z.string().trim().min(1).optional(),
});

export type MeetAvatarInput = z.infer<typeof MeetAvatarInputSchema>;

/**
 * Resolve the target meetingId from caller input + active sessions. Returns
 * `{ ok: true, meetingId }` when a single target is determined, or
 * `{ ok: false, content }` carrying the error string the tool should
 * surface verbatim. Mirrors the disambiguation logic in `meet_leave`,
 * `meet_send_chat`, and `meet_speak` so every meet_* tool behaves
 * consistently when called without an explicit meetingId.
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

class MeetEnableAvatarTool implements Tool {
  name = "meet_enable_avatar";
  description =
    "Turn on the assistant's video avatar in an active Google Meet call. The avatar lip-syncs to meet_speak output; it is off by default on join and must be explicitly enabled. See the Video avatar section of the meet-join SKILL.md for when to use this. When exactly one Meet session is active, meetingId may be omitted and the active session is targeted automatically; otherwise pass the specific meetingId returned by meet_join.";
  category = "meet";
  // Low: consent for on-camera participation is established meeting-wide
  // by `meet_join` (High) and the join-consent message; flipping the
  // avatar within that bounded session is within the user's expressed
  // consent envelope. Idempotent on the bot side (calling enable when
  // already on returns `alreadyRunning: true`), so a stray retry is
  // harmless. Aligns with the other in-meeting verbs (also Low).
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
              "The id of the meeting to enable the avatar in, as returned by meet_join. Optional when exactly one session is active.",
          },
        },
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
          "Error: the meet feature is disabled. Enable the `meet` feature flag to manage Google Meet calls.",
        isError: true,
      };
    }

    // 2. Input validation. All fields are optional so a bare `{}` is valid;
    //    Zod still catches wrong-type submissions.
    const parsed = MeetAvatarInputSchema.safeParse(input);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "invalid meet_enable_avatar input";
      return { content: `Error: ${message}`, isError: true };
    }
    const { meetingId: explicitId } = parsed.data;

    // 3. Disambiguate target session.
    const target = resolveTargetMeetingId(explicitId);
    if (!target.ok) {
      return { content: target.content, isError: true };
    }
    const targetMeetingId = target.meetingId;

    // 4. Delegate.
    try {
      const body = await MeetSessionManager.enableAvatar(targetMeetingId);
      return {
        content: JSON.stringify({ meetingId: targetMeetingId, ...body }),
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, meetingId: targetMeetingId },
        "meet_enable_avatar tool failed",
      );
      if (err instanceof MeetSessionNotFoundError) {
        return {
          content: `Error: no active Meet session for meetingId=${targetMeetingId}.`,
          isError: true,
        };
      }
      if (err instanceof MeetSessionUnreachableError) {
        return {
          content: `Error: meet bot unreachable — ${message}`,
          isError: true,
        };
      }
      if (err instanceof MeetBotAvatarError) {
        return {
          content: `Error: meet bot rejected avatar enable (status ${err.status}) — ${message}`,
          isError: true,
        };
      }
      return {
        content: `Error: failed to enable Meet avatar — ${message}`,
        isError: true,
      };
    }
  }
}

class MeetDisableAvatarTool implements Tool {
  name = "meet_disable_avatar";
  description =
    "Turn off the assistant's video avatar in an active Google Meet call. See the Video avatar section of the meet-join SKILL.md for when to use this (notably: disable during long stretches of silence so participants don't read the avatar as watching). When exactly one Meet session is active, meetingId may be omitted and the active session is targeted automatically; otherwise pass the specific meetingId returned by meet_join.";
  category = "meet";
  // Low: turning the assistant's own camera off is strictly less invasive
  // than turning it on, and idempotent on the bot side.
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
              "The id of the meeting to disable the avatar in, as returned by meet_join. Optional when exactly one session is active.",
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

    // 2. Input validation.
    const parsed = MeetAvatarInputSchema.safeParse(input);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "invalid meet_disable_avatar input";
      return { content: `Error: ${message}`, isError: true };
    }
    const { meetingId: explicitId } = parsed.data;

    // 3. Disambiguate target session.
    const target = resolveTargetMeetingId(explicitId);
    if (!target.ok) {
      return { content: target.content, isError: true };
    }
    const targetMeetingId = target.meetingId;

    // 4. Delegate. `disableAvatar` is idempotent on the bot side.
    try {
      const body = await MeetSessionManager.disableAvatar(targetMeetingId);
      return {
        content: JSON.stringify({ meetingId: targetMeetingId, ...body }),
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, meetingId: targetMeetingId },
        "meet_disable_avatar tool failed",
      );
      if (err instanceof MeetSessionNotFoundError) {
        return {
          content: `Error: no active Meet session for meetingId=${targetMeetingId}.`,
          isError: true,
        };
      }
      if (err instanceof MeetSessionUnreachableError) {
        return {
          content: `Error: meet bot unreachable — ${message}`,
          isError: true,
        };
      }
      if (err instanceof MeetBotAvatarError) {
        return {
          content: `Error: meet bot rejected avatar disable (status ${err.status}) — ${message}`,
          isError: true,
        };
      }
      return {
        content: `Error: failed to disable Meet avatar — ${message}`,
        isError: true,
      };
    }
  }
}

/** Exported singletons so the tool registry can re-register after test resets. */
export const meetEnableAvatarTool = new MeetEnableAvatarTool();
export const meetDisableAvatarTool = new MeetDisableAvatarTool();
