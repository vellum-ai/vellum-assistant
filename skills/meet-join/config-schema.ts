import { z } from "zod";

import { AVATAR_DEVICE_PATH_DEFAULT } from "./shared/avatar-device-path.js";

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

/**
 * Open enum of avatar renderer identifiers. Concrete renderer PRs (PR 5a–d)
 * register themselves against one of these ids and assert their required
 * option shape at `start()` time. The set is kept small and explicit here so
 * configuration mistakes (typos, wrong ids) surface at schema-validation time
 * rather than at meeting-join time; adding a new renderer is a single schema
 * change + a new factory registration.
 */
export const AVATAR_RENDERER_IDS = [
  "noop",
  "talking-head",
  "simli",
  "heygen",
  "tavus",
  "sadtalker",
  "musetalk",
] as const;

/**
 * Default v4l2loopback device node the renderer pushes frames into. Re-exports
 * the single source of truth from
 * {@link ./shared/avatar-device-path.js AVATAR_DEVICE_PATH_DEFAULT} so this
 * value cannot drift from its peers in `bot/src/browser/chrome-launcher.ts`,
 * `bot/src/media/video-device.ts`, and `cli/src/lib/docker.ts`.
 */
export const DEFAULT_AVATAR_DEVICE_PATH = AVATAR_DEVICE_PATH_DEFAULT;

/**
 * Per-renderer option block for TalkingHead.js (WebGL) renderer. All fields
 * optional at the schema level — the renderer's `start()` asserts the shape
 * it actually needs. Landed as a placeholder here so the config path exists
 * before the concrete renderer merges.
 */
const TalkingHeadAvatarOptionsSchema = z
  .object({
    /** Absolute path (or bot-container path) to the GLB avatar model. */
    modelPath: z
      .string({
        error: "services.meet.avatar.talkingHead.modelPath must be a string",
      })
      .optional()
      .describe("Path to the GLB avatar model used by the WebGL renderer."),
  })
  .optional()
  .describe("TalkingHead.js WebGL renderer options.");

/**
 * Per-renderer option block for the Simli hosted WebRTC renderer.
 * Credentials resolve through the vault via `apiKeyCredentialId` — the
 * schema never stores raw API keys.
 */
const SimliAvatarOptionsSchema = z
  .object({
    apiKeyCredentialId: z
      .string({
        error: "services.meet.avatar.simli.apiKeyCredentialId must be a string",
      })
      .optional()
      .describe(
        "Vault credential id that resolves to the Simli API key. Raw keys are never stored in config — always reference them through the credential vault.",
      ),
    avatarId: z
      .string({
        error: "services.meet.avatar.simli.avatarId must be a string",
      })
      .optional()
      .describe("Simli avatar identifier used for frame generation."),
  })
  .optional()
  .describe("Simli hosted WebRTC renderer options.");

/** HeyGen hosted renderer options — credentials via the vault. */
const HeygenAvatarOptionsSchema = z
  .object({
    apiKeyCredentialId: z
      .string({
        error:
          "services.meet.avatar.heygen.apiKeyCredentialId must be a string",
      })
      .optional(),
    avatarId: z
      .string({
        error: "services.meet.avatar.heygen.avatarId must be a string",
      })
      .optional(),
  })
  .optional()
  .describe("HeyGen hosted renderer options.");

/** Tavus hosted renderer options — credentials via the vault. */
const TavusAvatarOptionsSchema = z
  .object({
    apiKeyCredentialId: z
      .string({
        error: "services.meet.avatar.tavus.apiKeyCredentialId must be a string",
      })
      .optional(),
    replicaId: z
      .string({
        error: "services.meet.avatar.tavus.replicaId must be a string",
      })
      .optional(),
  })
  .optional()
  .describe("Tavus hosted renderer options.");

/** SadTalker GPU-sidecar options. */
const SadtalkerAvatarOptionsSchema = z
  .object({
    endpoint: z
      .string({
        error: "services.meet.avatar.sadtalker.endpoint must be a string",
      })
      .optional()
      .describe("HTTP endpoint for the SadTalker sidecar."),
    referenceImagePath: z
      .string({
        error:
          "services.meet.avatar.sadtalker.referenceImagePath must be a string",
      })
      .optional(),
  })
  .optional()
  .describe("SadTalker GPU-sidecar renderer options.");

/** MuseTalk GPU-sidecar options. */
const MusetalkAvatarOptionsSchema = z
  .object({
    endpoint: z
      .string({
        error: "services.meet.avatar.musetalk.endpoint must be a string",
      })
      .optional()
      .describe("HTTP endpoint for the MuseTalk sidecar."),
    referenceImagePath: z
      .string({
        error:
          "services.meet.avatar.musetalk.referenceImagePath must be a string",
      })
      .optional(),
  })
  .optional()
  .describe("MuseTalk GPU-sidecar renderer options.");

/**
 * Avatar subsystem schema for the Meet bot.
 *
 * The avatar pipeline is intentionally pluggable: the daemon resolves one of
 * several renderer backends (WebGL, hosted WebRTC, GPU sidecar) via the
 * renderer registry and pipes Y4M frames into the bot's v4l2loopback device.
 * When `enabled` is `false` or `renderer` is `"noop"`, the bot behaves like
 * Phase 3 — no video track is published. The per-renderer option blocks are
 * all optional at the schema level; each concrete renderer asserts its own
 * required shape inside its factory at `start()` time, so a misconfigured
 * renderer fails fast (and gracefully — callers catch
 * `AvatarRendererUnavailableError` and degrade to the noop renderer).
 *
 * Credentials are referenced via `credentialId` fields rather than raw keys
 * — the daemon resolves them through the vault before handing env vars to
 * the bot container (the bot has no vault access).
 */
const MeetAvatarSchema = z
  .object({
    enabled: z
      .boolean({
        error: "services.meet.avatar.enabled must be a boolean",
      })
      .default(false)
      .describe(
        "Whether the Meet bot publishes a virtual-camera video track with a synthesized avatar. Even when true, the top-level `meet` feature flag must also be on and the bot must be able to open the configured `devicePath` inside its container.",
      ),
    renderer: z
      .enum(AVATAR_RENDERER_IDS, {
        error:
          "services.meet.avatar.renderer must be one of: " +
          AVATAR_RENDERER_IDS.join(", "),
      })
      .default("noop")
      .describe(
        "Which avatar renderer backend to use. `noop` renders nothing and is the safe default; concrete backends (talking-head, simli, heygen, tavus, sadtalker, musetalk) register themselves with the renderer registry and assert their own configuration shape at start time.",
      ),
    devicePath: z
      .string({
        error: "services.meet.avatar.devicePath must be a string",
      })
      .default(DEFAULT_AVATAR_DEVICE_PATH)
      .describe(
        "Absolute v4l2loopback device node the renderer writes Y4M frames into. Must match the device passed through to the bot container via Docker `--device` and the Chrome `--use-file-for-fake-video-capture` flag.",
      ),
    talkingHead: TalkingHeadAvatarOptionsSchema,
    simli: SimliAvatarOptionsSchema,
    heygen: HeygenAvatarOptionsSchema,
    tavus: TavusAvatarOptionsSchema,
    sadtalker: SadtalkerAvatarOptionsSchema,
    musetalk: MusetalkAvatarOptionsSchema,
  })
  .default({
    enabled: false,
    renderer: "noop",
    devicePath: DEFAULT_AVATAR_DEVICE_PATH,
  })
  .describe(
    "Pluggable avatar renderer configuration. When enabled, the Meet bot publishes a synthesized video track to Meet via a v4l2loopback device.",
  );

/** Convenience export so the daemon can narrow on the fully-parsed shape. */
export type MeetAvatarConfig = z.infer<typeof MeetAvatarSchema>;

/** Narrow union of supported avatar renderer ids. */
export type AvatarRendererId = (typeof AVATAR_RENDERER_IDS)[number];

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
    voiceMode: z
      .object({
        enabled: z
          .boolean({
            error: "services.meet.voiceMode.enabled must be a boolean",
          })
          .default(true)
          .describe(
            "When on, 1:1 Meet calls (bot + one human) skip the proactive-chat Tier 1 regex and Tier 2 LLM and wake the agent after a short silence debounce on the last final transcript chunk. Group meetings (3+ participants) keep Tier 1 + Tier 2 behavior regardless of this flag.",
          ),
        eouDebounceMs: z
          .number({
            error: "services.meet.voiceMode.eouDebounceMs must be a number",
          })
          .int("services.meet.voiceMode.eouDebounceMs must be an integer")
          .nonnegative(
            "services.meet.voiceMode.eouDebounceMs must be non-negative",
          )
          .default(800)
          .describe(
            "Silence window after the last final transcript chunk before a 1:1 voice wake fires. Approximates end-of-utterance — long enough to ride through mid-sentence pauses, short enough to feel conversational.",
          ),
      })
      .default({
        enabled: true,
        eouDebounceMs: 800,
      })
      .describe(
        "1:1 voice-mode tuning. Active only when the live participant count is <= 2 (bot + one human).",
      ),
    avatar: MeetAvatarSchema,
  })
  .describe(
    "Google Meet bot configuration — controls the containerized Meet joining bot, consent messaging, and objection handling",
  );

export type MeetService = z.infer<typeof MeetServiceSchema>;
