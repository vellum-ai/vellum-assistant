/**
 * Perception event contract.
 *
 * Perception is the daemon's continuous, low-cost stream of "what is the user
 * doing right now". Raw frames (screenshots, audio, full OCR text) never leave
 * the originating process — only the structured events declared here cross the
 * IPC boundary into `assistantEventHub`.
 *
 * Producers: the `skills/perception/` skill is the canonical publisher;
 * additional skills may emit perception events as long as they respect the
 * privacy gate (no raw frames, redacted text, blocklist enforced upstream).
 *
 * Consumers: the in-process `ContextBuffer` (memory-only ring), the relevance
 * scorer, and the proactive trigger. None of these are allowed to read raw
 * frame data because the contract does not transport it.
 *
 * Roadmap: `docs/jarvis-roadmap.md`.
 */

import { z } from "zod";

/**
 * The kinds of perception signals the daemon understands.
 *
 * Phase 1 ships `app_focus_changed` only. Later phases add screenshot-derived,
 * audio-derived, and editor-derived signals — each new kind must update this
 * union AND add a corresponding payload schema in {@link PerceptionPayload}.
 */
export const PERCEPTION_EVENT_KINDS = [
  "app_focus_changed",
  "task_detected",
  "meeting_started",
  "code_edited",
  "relevance_scored",
  "screen_snapshot",
  "audio_excerpt",
] as const;

export type PerceptionEventKind = (typeof PERCEPTION_EVENT_KINDS)[number];

/**
 * Source process that produced the event. Used for audit + debugging; not
 * for trust decisions (trust comes from the skill IPC handshake, not from
 * a field in the payload).
 */
export const PerceptionSourceSchema = z.object({
  /** Skill or module identifier, e.g. `"skills/perception"`. */
  module: z.string().min(1).max(128),
  /** Optional version/build tag for triage. */
  version: z.string().max(64).optional(),
});

export type PerceptionSource = z.infer<typeof PerceptionSourceSchema>;

/**
 * `app_focus_changed` — the user switched focus to a different app or window.
 *
 * Privacy: window titles often contain document names. The producer must run
 * its blocklist + redaction pass before emitting. The contract intentionally
 * does NOT carry process ids, file paths, or URLs — those are higher-trust
 * signals that need their own gated kind.
 */
export const AppFocusChangedPayloadSchema = z.object({
  kind: z.literal("app_focus_changed"),
  /** Bundle id or platform-native app identifier, e.g. `com.apple.Safari`. */
  appId: z.string().min(1).max(256),
  /** Human-readable app name as the OS reports it. */
  appName: z.string().min(1).max(256),
  /** Redacted window title. Empty string when unavailable or fully redacted. */
  windowTitle: z.string().max(512),
  /** Whether the window title was redacted by the producer. */
  redacted: z.boolean(),
});

export type AppFocusChangedPayload = z.infer<
  typeof AppFocusChangedPayloadSchema
>;

/**
 * `task_detected` — interpreted, higher-level task signal inferred from raw
 * focus changes by the local perception interpreter.
 *
 * Privacy: this is a distilled summary and must never include direct secrets
 * (emails, full tokens, phone numbers, exact account IDs). Producers should
 * redact/normalize before emitting.
 */
export const TaskDetectedPayloadSchema = z.object({
  kind: z.literal("task_detected"),
  /** Short task label suitable for downstream routing/scoring. */
  label: z.string().min(1).max(120),
  /** User-facing, redacted summary of what the user appears to be doing. */
  summary: z.string().max(320),
  /** Confidence score in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** Source perception event id that triggered this interpretation. */
  sourceEventId: z.string().min(1).max(128),
});

export type TaskDetectedPayload = z.infer<typeof TaskDetectedPayloadSchema>;

/**
 * `meeting_started` — interpreted signal that the user appears to have entered
 * a live meeting context.
 */
export const MeetingStartedPayloadSchema = z.object({
  kind: z.literal("meeting_started"),
  /** Redacted user-facing summary. */
  summary: z.string().max(320),
  /** Confidence score in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** Source perception event id that triggered this interpretation. */
  sourceEventId: z.string().min(1).max(128),
  /** Best-effort meeting platform classification. */
  platform: z
    .enum(["zoom", "google-meet", "teams", "slack-huddle", "other"])
    .optional(),
});

export type MeetingStartedPayload = z.infer<typeof MeetingStartedPayloadSchema>;

/**
 * `code_edited` — interpreted signal that the user appears to be actively
 * editing code.
 */
export const CodeEditedPayloadSchema = z.object({
  kind: z.literal("code_edited"),
  /** Redacted user-facing summary. */
  summary: z.string().max(320),
  /** Confidence score in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** Source perception event id that triggered this interpretation. */
  sourceEventId: z.string().min(1).max(128),
  /** Optional coarse workspace/project hint when available. */
  workspaceHint: z.string().max(120).optional(),
  /** Optional language hint, e.g. "TypeScript". */
  languageHint: z.string().max(40).optional(),
});

export type CodeEditedPayload = z.infer<typeof CodeEditedPayloadSchema>;

export const RelevanceDecisionSchema = z.enum([
  "ignore",
  "remember",
  "maybe-act",
  "act-now",
]);

export type RelevanceDecision = z.infer<typeof RelevanceDecisionSchema>;

export const RelevanceUrgencySchema = z.enum(["low", "medium", "high"]);

export type RelevanceUrgency = z.infer<typeof RelevanceUrgencySchema>;

/**
 * `relevance_scored` — canonical output from the Phase 3 relevance gate.
 *
 * Captures the scorer's decision for one interpreted event, including whether
 * an `act-now` decision actually triggered a proactive wake or was blocked by
 * interruption budget.
 */
export const RelevanceScoredPayloadSchema = z.object({
  kind: z.literal("relevance_scored"),
  /** Perception event id that was scored by the relevance gate. */
  sourceEventId: z.string().min(1).max(128),
  /** Interpreted source event kind that was scored. */
  sourceKind: z.enum(["task_detected", "meeting_started", "code_edited"]),
  /** Relevance decision class from the scorer. */
  decision: RelevanceDecisionSchema,
  /** Relative urgency used for budget + trigger policy. */
  urgency: RelevanceUrgencySchema,
  /** Redacted short explanation for audit/debugging. */
  reason: z.string().max(240).optional(),
  /**
   * True when an `act-now` decision actually invoked the proactive wake path.
   * False for all non-act-now decisions and budget-blocked/skipped outcomes.
   */
  triggeredWake: z.boolean(),
  /** True when an `act-now` decision was blocked by the hourly budget. */
  blockedByBudget: z.boolean(),
  /** Background conversation id used for wake, when one was invoked. */
  wakeConversationId: z.string().min(1).max(128).optional(),
});

export type RelevanceScoredPayload = z.infer<
  typeof RelevanceScoredPayloadSchema
>;

/**
 * `screen_snapshot` — sanitized OCR / accessibility-tree summary captured from
 * the user's screen by an on-device producer (e.g. macOS WatchSession).
 *
 * Privacy: raw images NEVER cross IPC. The producer runs OCR and any
 * accessibility-tree extraction locally, applies its blocklist + redaction
 * pass, and emits the truncated structured fields declared here. The hard
 * 2048-character cap on `ocrTextRedacted` is enforced both by schema and by
 * the route-level sanitizer.
 *
 * This kind is gated by the `perception-screen-snapshot` feature flag AND by
 * a per-conversation `perception_consent_grants` row — both must be present
 * for the daemon to accept the event.
 */
export const ScreenSnapshotPayloadSchema = z.object({
  kind: z.literal("screen_snapshot"),
  /**
   * Conversation that the publisher associates the snapshot with. The
   * `perception_consent_grants` table is keyed on this id; the route rejects
   * with `consent_required` when no active grant exists for the triple.
   */
  conversationId: z.string().min(1).max(128),
  /** Bundle id of the captured foreground app. */
  appId: z.string().min(1).max(256),
  /** Human-readable app name. */
  appName: z.string().min(1).max(256),
  /** Redacted window title (empty if redacted/unavailable). */
  windowTitle: z.string().max(512),
  /**
   * Redacted, truncated text extracted from the screen. Capped at 2048
   * characters to bound prompt impact. Producers are expected to truncate
   * upstream; the route sanitizer enforces the cap defensively.
   */
  ocrTextRedacted: z.string().max(2048),
  /** Whether any redaction took place. */
  redacted: z.boolean(),
  /** How the producer extracted text from the screen. */
  captureMethod: z.enum(["ax", "ocr"]),
  /** Producer-reported confidence in the extraction, in [0, 1]. */
  confidence: z.number().min(0).max(1),
});

export type ScreenSnapshotPayload = z.infer<typeof ScreenSnapshotPayloadSchema>;

/**
 * `audio_excerpt` — a sanitized excerpt of a finalized speech-to-text turn
 * captured by the live-voice session.
 *
 * Privacy: raw audio NEVER crosses IPC. Only the redacted transcript text is
 * forwarded into the perception spine, capped at 1024 characters.
 *
 * This kind is gated by the `perception-audio-excerpt` feature flag AND by a
 * per-conversation `perception_consent_grants` row.
 */
export const AudioExcerptPayloadSchema = z.object({
  kind: z.literal("audio_excerpt"),
  /**
   * Conversation that the publisher associates the excerpt with. The
   * `perception_consent_grants` table is keyed on this id; the route rejects
   * with `consent_required` when no active grant exists for the triple.
   */
  conversationId: z.string().min(1).max(128),
  /** Live-voice session id that produced the excerpt. */
  sessionId: z.string().min(1).max(128),
  /** Stable id for the conversational turn the excerpt belongs to. */
  turnId: z.string().min(1).max(128),
  /**
   * Redacted, truncated finalized STT transcript. Bounded at 1024 characters
   * (schema + route sanitizer both enforce).
   */
  transcriptRedacted: z.string().max(1024),
  /** Optional BCP-47 language tag, e.g. "en-US". */
  language: z.string().max(20).optional(),
  /** Producer-reported confidence in the STT result, in [0, 1]. */
  confidence: z.number().min(0).max(1),
});

export type AudioExcerptPayload = z.infer<typeof AudioExcerptPayloadSchema>;

/**
 * Discriminated union of all perception payload shapes. Extend here when
 * adding a new kind; the union name `kind` is the discriminator.
 */
export const PerceptionPayloadSchema = z.discriminatedUnion("kind", [
  AppFocusChangedPayloadSchema,
  TaskDetectedPayloadSchema,
  MeetingStartedPayloadSchema,
  CodeEditedPayloadSchema,
  RelevanceScoredPayloadSchema,
  ScreenSnapshotPayloadSchema,
  AudioExcerptPayloadSchema,
]);

export type PerceptionPayload = z.infer<typeof PerceptionPayloadSchema>;

/**
 * The full envelope published to `assistantEventHub`.
 *
 * `ts` is the producer's wall-clock at capture time. The hub also stamps its
 * own receive time on the outer `AssistantEvent` — they may diverge if the
 * producer batches.
 */
export const PerceptionEventSchema = z.object({
  /** Monotonic, opaque event id assigned by the producer. */
  eventId: z.string().min(1).max(128),
  /** ISO-8601 timestamp at capture time. */
  ts: z.string().datetime(),
  source: PerceptionSourceSchema,
  payload: PerceptionPayloadSchema,
});

export type PerceptionEvent = z.infer<typeof PerceptionEventSchema>;

/**
 * Tag used by `assistantEventHub` consumers to filter for the perception
 * family. Producers MUST set this on the outer `AssistantEvent.type` so
 * subscribers can subscribe without parsing the payload.
 *
 * Concrete event types nest the kind, e.g. `perception.app_focus_changed`,
 * so consumers can subscribe coarsely (`perception.*`) or precisely.
 */
export const PERCEPTION_EVENT_TYPE_PREFIX = "perception" as const;

export function perceptionEventType(kind: PerceptionEventKind): string {
  return `${PERCEPTION_EVENT_TYPE_PREFIX}.${kind}`;
}

/**
 * Parse + validate an unknown payload as a perception event. Producers and
 * consumers both call this at the trust boundary to avoid leaking malformed
 * input into the in-process consumers.
 */
export function parsePerceptionEvent(input: unknown): PerceptionEvent {
  return PerceptionEventSchema.parse(input);
}
