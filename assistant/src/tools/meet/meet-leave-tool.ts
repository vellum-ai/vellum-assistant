/**
 * meet_leave tool — voluntary teardown of an active Meet session.
 *
 * Paired with {@link ./meet-join-tool.ts meet_join}; see that file for the
 * justification of registering these as first-party tools rather than a
 * skill-driven CLI. The short version: the Meet subsystem holds
 * in-process lifecycle state (containers, sockets, event subscribers)
 * that a CLI skill cannot command directly, so we keep the control
 * surface in-process and use the `meet-join` skill for natural-language
 * routing.
 */

import { z } from "zod";

import { MeetSessionManager } from "../../../../skills/meet-join/daemon/session-manager.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import { MEET_FLAG_KEY } from "./meet-join-tool.js";

const log = getLogger("meet-leave-tool");

/** Default reason recorded when the caller doesn't supply one. */
export const DEFAULT_LEAVE_REASON = "requested";

const MeetLeaveInputSchema = z.object({
  meetingId: z.string().trim().min(1).optional(),
  reason: z.string().optional(),
});

export type MeetLeaveInput = z.infer<typeof MeetLeaveInputSchema>;

class MeetLeaveTool implements Tool {
  name = "meet_leave";
  description =
    "Leave an active Google Meet call that the assistant previously joined. When exactly one Meet session is active, meetingId may be omitted and the active session is targeted automatically; otherwise pass the specific meetingId returned by meet_join.";
  category = "meet";
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
              "The id of the meeting to leave, as returned by meet_join. Optional when exactly one session is active.",
          },
          reason: {
            type: "string",
            description:
              "Free-form reason recorded with the leave event (e.g. 'user-requested', 'task-complete'). Defaults to 'requested'.",
          },
        },
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // 1. Feature-flag gate — symmetric with meet_join so that disabling
    //    the feature blocks both sides of the lifecycle instead of
    //    leaking a half-working interface.
    const config = getConfig();
    if (!isAssistantFeatureFlagEnabled(MEET_FLAG_KEY, config)) {
      return {
        content:
          "Error: the meet feature is disabled. Enable the `meet` feature flag to manage Google Meet calls.",
        isError: true,
      };
    }

    // 2. Input validation. All fields are optional so a bare `{}` is valid;
    //    Zod still catches wrong-type submissions and we surface the first
    //    issue verbatim for debuggability.
    const parsed = MeetLeaveInputSchema.safeParse(input);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "invalid meet_leave input";
      return { content: `Error: ${message}`, isError: true };
    }
    const { meetingId: explicitId, reason } = parsed.data;

    // 3. Disambiguate the target session when no id is supplied. Ambiguity
    //    (zero or multiple active sessions) is a caller error: we refuse
    //    rather than guess, so the skill can prompt the user for the
    //    specific meeting.
    let targetMeetingId: string;
    if (explicitId) {
      targetMeetingId = explicitId;
    } else {
      const active = MeetSessionManager.activeSessions();
      if (active.length === 0) {
        return {
          content: "Error: no active Meet session to leave.",
          isError: true,
        };
      }
      if (active.length > 1) {
        const ids = active.map((s) => s.meetingId).join(", ");
        return {
          content: `Error: multiple active Meet sessions (${ids}). Pass meetingId explicitly.`,
          isError: true,
        };
      }
      targetMeetingId = active[0].meetingId;
    }

    // 4. Delegate. `leave()` is idempotent for unknown meeting ids, so we
    //    don't need a pre-flight existence check — but we do call it out
    //    in the response when nothing matched, to avoid telling the
    //    model "left" for a no-op.
    const sessionBefore = MeetSessionManager.getSession(targetMeetingId);
    const leaveReason = reason?.trim() ? reason.trim() : DEFAULT_LEAVE_REASON;

    try {
      await MeetSessionManager.leave(targetMeetingId, leaveReason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, meetingId: targetMeetingId, reason: leaveReason },
        "meet_leave tool failed",
      );
      return {
        content: `Error: failed to leave Meet — ${message}`,
        isError: true,
      };
    }

    if (!sessionBefore) {
      return {
        content: JSON.stringify({
          left: false,
          meetingId: targetMeetingId,
          note: "no active session matched that meetingId",
        }),
        isError: false,
      };
    }

    return {
      content: JSON.stringify({ left: true, meetingId: targetMeetingId }),
      isError: false,
    };
  }
}

/** Exported singleton so the tool registry can re-register it after test resets. */
export const meetLeaveTool = new MeetLeaveTool();
