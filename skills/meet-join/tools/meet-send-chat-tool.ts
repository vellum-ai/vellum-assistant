/**
 * meet_send_chat tool — post a chat message into an active Meet call.
 *
 * Paired with {@link ./meet-join-tool.ts meet_join} and
 * {@link ./meet-leave-tool.ts meet_leave}: all three are first-party tools
 * because they command the in-process `MeetSessionManager`. See the
 * rationale comment at the top of `meet-join-tool.ts` — keeping the chat
 * control surface in-process avoids a new HTTP API that mirrors the same
 * session-manager state.
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
  MeetBotChatError,
  MeetSessionManager,
  MeetSessionNotFoundError,
  MeetSessionUnreachableError,
} from "../daemon/session-manager.js";
import { MEET_FLAG_KEY } from "./meet-join-tool.js";

const log = getLogger("meet-send-chat-tool");

const MeetSendChatInputSchema = z.object({
  meetingId: z.string().trim().min(1).optional(),
  text: z.string().min(1, "text is required"),
});

export type MeetSendChatInput = z.infer<typeof MeetSendChatInputSchema>;

class MeetSendChatTool implements Tool {
  name = "meet_send_chat";
  description =
    "Post a message into the chat of an active Google Meet call. When exactly one Meet session is active, meetingId may be omitted and the active session is targeted automatically; otherwise pass the specific meetingId returned by meet_join.";
  category = "meet";
  // Low: consent is established meeting-wide by `meet_join` (High) and the
  // Phase 1 join-consent message announcing the bot. Chat posts within that
  // bounded session are within the user's expressed consent envelope, and
  // proactive-chat wakes run on client-less conversations where a Medium-risk
  // approval prompt would hang forever. Aligns with `meet_leave` (also Low).
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
              "The id of the meeting to send chat to, as returned by meet_join. Optional when exactly one session is active.",
          },
          text: {
            type: "string",
            description:
              "The message text to post into the meeting chat. Keep it concise and conversational.",
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
    // 1. Feature-flag gate — symmetric with meet_join / meet_leave.
    const config = getConfig();
    if (!isAssistantFeatureFlagEnabled(MEET_FLAG_KEY, config)) {
      return {
        content:
          "Error: the meet feature is disabled. Enable the `meet` feature flag to send chat in Google Meet calls.",
        isError: true,
      };
    }

    // 2. Input validation.
    const parsed = MeetSendChatInputSchema.safeParse(input);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "invalid meet_send_chat input";
      return { content: `Error: ${message}`, isError: true };
    }
    const { meetingId: explicitId, text } = parsed.data;

    // 3. Disambiguate target session when no id is supplied. Zero or >1
    //    active sessions is a caller error — refuse rather than guess.
    let targetMeetingId: string;
    if (explicitId) {
      targetMeetingId = explicitId;
    } else {
      const active = MeetSessionManager.activeSessions();
      if (active.length === 0) {
        return {
          content: "Error: no active Meet session to send chat to.",
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

    // 4. Delegate.
    try {
      await MeetSessionManager.sendChat(targetMeetingId, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, meetingId: targetMeetingId, textLength: text.length },
        "meet_send_chat tool failed",
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
      if (err instanceof MeetBotChatError) {
        return {
          content: `Error: meet bot rejected the chat (status ${err.status}) — ${message}`,
          isError: true,
        };
      }
      return {
        content: `Error: failed to send Meet chat — ${message}`,
        isError: true,
      };
    }

    return {
      content: JSON.stringify({ sent: true, meetingId: targetMeetingId }),
      isError: false,
    };
  }
}

/** Exported singleton so the tool registry can re-register it after test resets. */
export const meetSendChatTool = new MeetSendChatTool();
