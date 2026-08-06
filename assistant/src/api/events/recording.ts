/**
 * Recording lifecycle SSE events (`recording_start` / `_stop` / `_pause` /
 * `_resume`).
 *
 * Server → client instructions that drive a screen recording on the
 * client: the daemon assigns `recordingId` on `recording_start` and the
 * subsequent stop/pause/resume events reference it. `recording_start`
 * also carries capture `options` and an `operationToken` that guards
 * against stale restart completions.
 *
 * Canonical wire-contract source. Daemon code imports the types
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

/** Recording options shared across standalone and CU recording flows. */
export const RecordingOptionsSchema = z.object({
  captureScope: z.enum(["display", "window"]).optional(),
  /** CGDirectDisplayID as string. */
  displayId: z.string().optional(),
  /** CGWindowID. */
  windowId: z.number().optional(),
  includeAudio: z.boolean().optional(),
  includeMicrophone: z.boolean().optional(),
  /** Show source picker. */
  promptForSource: z.boolean().optional(),
});

export type RecordingOptions = z.infer<typeof RecordingOptionsSchema>;

export const RecordingStartEventSchema = z.object({
  type: z.literal("recording_start"),
  /** Daemon-assigned UUID. */
  recordingId: z.string(),
  attachToConversationId: z.string().optional(),
  options: RecordingOptionsSchema.optional(),
  /**
   * Operation token for restart race hardening — stale completions with
   * mismatched tokens are rejected.
   */
  operationToken: z.string().optional(),
});

export type RecordingStartEvent = z.infer<typeof RecordingStartEventSchema>;

export const RecordingStopEventSchema = z.object({
  type: z.literal("recording_stop"),
  /** Matches `recording_start`'s recordingId. */
  recordingId: z.string(),
});

export type RecordingStopEvent = z.infer<typeof RecordingStopEventSchema>;

export const RecordingPauseEventSchema = z.object({
  type: z.literal("recording_pause"),
  recordingId: z.string(),
});

export type RecordingPauseEvent = z.infer<typeof RecordingPauseEventSchema>;

export const RecordingResumeEventSchema = z.object({
  type: z.literal("recording_resume"),
  recordingId: z.string(),
});

export type RecordingResumeEvent = z.infer<typeof RecordingResumeEventSchema>;
