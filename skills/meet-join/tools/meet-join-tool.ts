/**
 * meet_join tool — join a Google Meet call via the managed meet-bot container.
 *
 * Why this is a registered tool rather than a skill-driven CLI (see
 * `assistant/src/tools/AGENTS.md`, "New Non-Skill Tools Are Strongly
 * Discouraged"):
 *
 *   The Meet feature hangs off `MeetSessionManager`, a process-lifecycle
 *   resource owned by the daemon: it spawns Docker containers, holds
 *   per-meeting audio-ingest sockets, manages bearer tokens, and fans
 *   live events to connected clients. A skill running from a CLI would
 *   not have in-process access to that state — every operation would
 *   require a new HTTP surface that mirrors the in-process API. Keeping
 *   `meet_join` / `meet_leave` as first-party tools lets the assistant
 *   command the session manager directly, while the `meet-join` skill
 *   (`skills/meet-join/SKILL.md`) provides the natural-language routing
 *   guidance ("when to join / when not to join"). Tool + skill together
 *   keep the model-facing surface idiomatic and the daemon-facing
 *   surface in-process.
 */

import { randomUUID } from "node:crypto";

import type {
  SkillHost,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@vellumai/skill-host-contracts";
import { RiskLevel } from "@vellumai/skill-host-contracts";
import { z } from "zod";

import { getMeetConfig } from "../meet-config.js";
import { MeetSessionManager } from "../daemon/session-manager.js";

/** Feature-flag key that gates the Meet joining bot end-to-end. */
export const MEET_FLAG_KEY = "meet" as const;

/** Fallback assistant name when `IDENTITY.md` has not been written yet. */
export const DEFAULT_ASSISTANT_NAME = "Vellum";

/**
 * URL shape check for `https://meet.google.com/<xxx-yyyy-zzz>` style links.
 * Accepts the typical three-segment form with the middle four-letter block
 * and tolerates optional query strings (Meet occasionally appends tracking
 * params like `?authuser=0`). Case-insensitive to keep paste-mangled URLs
 * (e.g. from mobile share sheets) from failing unnecessarily.
 */
export const MEET_URL_REGEX =
  /^https:\/\/meet\.google\.com\/[a-z]{3,4}-?[a-z]{4}-?[a-z]{3,4}(?:\?.*)?$/i;

const MeetJoinInputSchema = z.object({
  url: z.string().trim().min(1, "url is required").regex(MEET_URL_REGEX, {
    message:
      "url must be a Google Meet link (https://meet.google.com/xxx-yyyy-zzz)",
  }),
  note: z.string().optional(),
});

export type MeetJoinInput = z.infer<typeof MeetJoinInputSchema>;

/**
 * Substitute `{assistantName}` in a consent-message template. Safe against
 * empty templates and against names that happen to contain regex-magic
 * characters — uses a plain split/join rather than a RegExp.
 */
export function substituteAssistantName(
  template: string,
  assistantName: string,
): string {
  return template.split("{assistantName}").join(assistantName);
}

/**
 * Build the `meet_join` tool, wired to the supplied `SkillHost` for
 * feature-flag reads, assistant identity, and logging.
 */
export function createMeetJoinTool(host: SkillHost): Tool {
  const log = host.logger.get("meet-join-tool");

  return {
    name: "meet_join",
    description:
      "Join a Google Meet call as an AI note-taker. The bot announces itself in the meeting chat, captures a live transcript, and can be asked to leave at any time. Only call this when the user explicitly asks the assistant to join a specific Meet URL.",
    category: "meet",
    defaultRiskLevel: RiskLevel.High,

    getDefinition(): ToolDefinition {
      return {
        name: this.name,
        description: this.description,
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "The Google Meet URL to join, e.g. https://meet.google.com/xxx-yyyy-zzz.",
            },
            note: {
              type: "string",
              description:
                "Optional free-form note about why the assistant is joining (recorded alongside the session for later reference).",
            },
          },
          required: ["url"],
        },
      };
    },

    async execute(
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> {
      // 1. Feature-flag gate. Keep the error wording stable so the skill can
      //    relay it verbatim to the user without surprises.
      if (!host.config.isFeatureFlagEnabled(MEET_FLAG_KEY)) {
        return {
          content:
            "Error: the meet feature is disabled. Enable the `meet` feature flag to join Google Meet calls.",
          isError: true,
        };
      }

      // 2. Input validation.
      const parsed = MeetJoinInputSchema.safeParse(input);
      if (!parsed.success) {
        const message =
          parsed.error.issues[0]?.message ?? "invalid meet_join input";
        return { content: `Error: ${message}`, isError: true };
      }
      const { url, note } = parsed.data;

      // 3. Consent-message substitution. We resolve `{assistantName}` here so
      //    the substituted string reaches the bot container via the session
      //    manager — keeping the substitution in the tool lets the config
      //    value remain a template (stable across renames) while the bot
      //    sees a human-readable greeting.
      const meetConfig = getMeetConfig(host.platform.workspaceDir());
      const rawTemplate = meetConfig.consentMessage;
      const assistantName =
        host.identity.getAssistantName() ?? DEFAULT_ASSISTANT_NAME;
      const consentMessage = substituteAssistantName(
        rawTemplate,
        assistantName,
      );

      // 4. Generate a fresh meeting id. UUIDs give us the cryptographic
      //    uniqueness the session manager's per-meeting token resolver
      //    expects without having to coordinate ids across subsystems.
      const meetingId = randomUUID();

      // 5. Delegate to the session manager. Failures surface as tool errors
      //    rather than throwing, so the agent loop can re-prompt the user
      //    with a clear message instead of marking the whole turn as an
      //    unexpected failure.
      try {
        const session = await MeetSessionManager.join({
          url,
          meetingId,
          conversationId: context.conversationId,
          consentMessage,
        });

        log.info("meet_join tool spawned a Meet session", {
          meetingId: session.meetingId,
          conversationId: session.conversationId,
          containerId: session.containerId,
          note: note ? "[present]" : undefined,
        });

        return {
          content: JSON.stringify({
            meetingId: session.meetingId,
            status: "joining",
          }),
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("meet_join tool failed to start a Meet session", {
          err,
          meetingId,
          url,
        });
        return {
          content: `Error: failed to join Meet — ${message}`,
          isError: true,
        };
      }
    },
  };
}
