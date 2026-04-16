import { z } from "zod";

/**
 * Default keywords that signal an objection to the assistant's presence in a
 * meeting. When any of these (case-insensitive substring match) appear in
 * captured transcript text, the bot should auto-leave if
 * `autoLeaveOnObjection` is enabled.
 */
// False positives here only trigger an extra LLM confirmation — bias toward coverage.
export const DEFAULT_MEET_OBJECTION_KEYWORDS: readonly string[] = [
  // existing
  "please leave",
  "stop recording",
  "no bots",
  "no recording",
  "I don't consent",
  "can the bot leave",
  // new — polite requests
  "can you leave",
  "could you leave",
  "would you mind leaving",
  "please exit",
  "step out",
  // new — direct objections
  "no AI",
  "turn off the bot",
  "turn off the AI",
  "remove the bot",
  "kick the bot",
  "mute the bot",
  "stop listening",
  "stop transcribing",
  // new — discomfort signaling
  "not comfortable",
  "don't record",
  "don't want this recorded",
];

/**
 * Default Tier 1 regex keyword patterns for the proactive-chat opportunity
 * detector. Each entry is compiled as a case-insensitive {@link RegExp} at
 * runtime. Patterns are intentionally broad — false positives only trigger
 * a Tier 2 LLM confirmation, so we bias toward coverage.
 */
export const DEFAULT_MEET_PROACTIVE_CHAT_KEYWORDS: readonly string[] = [
  // Direct "can you / could you / would you / will you" requests
  "\\b(can|could|would|will)\\s+you\\b",
  // Collective requests addressed to anyone in the meeting
  "\\bcan\\s+(anyone|someone)\\b",
  "\\bdoes\\s+(anyone|someone)\\s+know\\b",
  "\\banyone\\s+(have|know)\\b",
];

/**
 * Normalize `joinName` — coerce empty or whitespace-only strings to `null` so
 * downstream code only has to check for `null` when deciding whether to fall
 * back to the assistant's display name. This keeps the semantic invariant
 * that `joinName === null` means "use the assistant display name at runtime".
 */
function normalizeJoinName(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export const MeetServiceSchema = z
  .object({
    enabled: z
      .boolean({ error: "services.meet.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether the Google Meet joining bot is enabled. Even when true, the top-level `meet` feature flag must also be on for the feature to surface.",
      ),
    containerImage: z
      .string({ error: "services.meet.containerImage must be a string" })
      .transform((v) => v || "vellum-meet-bot:dev")
      .default("vellum-meet-bot:dev")
      .describe(
        "Docker image tag used to spawn the Meet bot container for each joined meeting",
      ),
    joinName: z
      .string({ error: "services.meet.joinName must be a string" })
      .nullable()
      .default(null)
      .transform(normalizeJoinName)
      .describe(
        "Display name the bot uses when joining a meeting. When null (the default) the assistant's display name is used at runtime. Empty or whitespace-only strings are normalized to null.",
      ),
    consentMessage: z
      .string({ error: "services.meet.consentMessage must be a string" })
      .default(
        "Hi, I'm {assistantName}, an AI assistant joining to take notes. Let me know if you'd prefer I leave.",
      )
      .describe(
        "Message the bot posts in meeting chat on join. `{assistantName}` is substituted at runtime.",
      ),
    autoLeaveOnObjection: z
      .boolean({
        error: "services.meet.autoLeaveOnObjection must be a boolean",
      })
      .default(true)
      .describe(
        "Whether the bot automatically leaves the meeting when a participant voices one of the objection keywords",
      ),
    objectionKeywords: z
      .array(
        z.string({
          error: "services.meet.objectionKeywords values must be strings",
        }),
      )
      .default([...DEFAULT_MEET_OBJECTION_KEYWORDS])
      .describe(
        "Case-insensitive substrings that trigger auto-leave when detected in live transcript text",
      ),
    dockerNetwork: z
      .string({ error: "services.meet.dockerNetwork must be a string" })
      .transform((v) => v || "bridge")
      .default("bridge")
      .describe("Docker network the Meet bot container attaches to"),
    maxMeetingMinutes: z
      .number({ error: "services.meet.maxMeetingMinutes must be a number" })
      .int("services.meet.maxMeetingMinutes must be an integer")
      .positive("services.meet.maxMeetingMinutes must be a positive integer")
      .default(240)
      .describe(
        "Hard ceiling in minutes — the bot container is killed once this elapses, regardless of meeting state",
      ),
    proactiveChat: z
      .object({
        enabled: z
          .boolean({
            error: "services.meet.proactiveChat.enabled must be a boolean",
          })
          .default(true)
          .describe(
            "Whether the assistant proactively watches meeting transcript and chat for opportunities to respond via meeting chat.",
          ),
        detectorKeywords: z
          .array(
            z.string({
              error:
                "services.meet.proactiveChat.detectorKeywords values must be strings",
            }),
          )
          .default([...DEFAULT_MEET_PROACTIVE_CHAT_KEYWORDS])
          .describe(
            "Tier 1 regex patterns (case-insensitive) that trigger a Tier 2 LLM confirmation when matched against transcript or chat text.",
          ),
        tier2DebounceMs: z
          .number({
            error:
              "services.meet.proactiveChat.tier2DebounceMs must be a number",
          })
          .int("services.meet.proactiveChat.tier2DebounceMs must be an integer")
          .nonnegative(
            "services.meet.proactiveChat.tier2DebounceMs must be non-negative",
          )
          .default(5_000)
          .describe(
            "Minimum milliseconds between consecutive Tier 2 LLM calls. Tier 1 hits arriving within this window are collapsed into a single LLM call.",
          ),
        escalationCooldownSec: z
          .number({
            error:
              "services.meet.proactiveChat.escalationCooldownSec must be a number",
          })
          .int(
            "services.meet.proactiveChat.escalationCooldownSec must be an integer",
          )
          .nonnegative(
            "services.meet.proactiveChat.escalationCooldownSec must be non-negative",
          )
          .default(30)
          .describe(
            "Seconds between consecutive positive escalations. A Tier 2 positive verdict arriving within this window of the previous escalation is suppressed.",
          ),
        tier2MaxTranscriptSec: z
          .number({
            error:
              "services.meet.proactiveChat.tier2MaxTranscriptSec must be a number",
          })
          .int(
            "services.meet.proactiveChat.tier2MaxTranscriptSec must be an integer",
          )
          .positive(
            "services.meet.proactiveChat.tier2MaxTranscriptSec must be positive",
          )
          .default(30)
          .describe(
            "Rolling transcript window (seconds) included in the Tier 2 LLM prompt.",
          ),
      })
      .default({
        enabled: true,
        detectorKeywords: [...DEFAULT_MEET_PROACTIVE_CHAT_KEYWORDS],
        tier2DebounceMs: 5_000,
        escalationCooldownSec: 30,
        tier2MaxTranscriptSec: 30,
      })
      .describe(
        "Proactive-chat opportunity detector tuning. The detector uses a Tier 1 regex fast filter plus a Tier 2 LLM confirmation before the assistant posts in meeting chat.",
      ),
  })
  .describe(
    "Google Meet bot configuration — controls the containerized Meet joining bot, consent messaging, and objection handling",
  );

export type MeetService = z.infer<typeof MeetServiceSchema>;
