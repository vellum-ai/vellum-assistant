import { z } from "zod";

/**
 * How many camera frames stay in the model's context as real images, counted
 * newest-first across the whole conversation so the frames from the last few
 * moments are the ones that survive. Older frames become timestamped text
 * stubs (`daemon/conversation-sight-frames.ts`).
 *
 * Smaller than `RETRY_KEEP_LATEST_MEDIA_BLOCKS` (3, in
 * `daemon/conversation-media-retry.ts`) because the two budgets answer
 * different questions. That one is reactive and spends a rejected request's
 * remaining room across every kind of media, including files the user
 * deliberately sent. This one is proactive, applied to every assembly, and
 * governs only frames the camera sampled by itself: background the model
 * glances at, not something anyone chose to attach.
 */
export const KEEP_LATEST_SIGHT_FRAMES = 2;

/**
 * Floor for `sight.keepLatestFrames`. A call whose camera is up keeps at least
 * the current view live; stubbing every frame would leave the model reading
 * timestamps about pictures it can no longer see.
 */
export const MIN_SIGHT_KEEP_LATEST_FRAMES = 1;

/**
 * Ceiling for `sight.keepLatestFrames`. History resends every inline image on
 * every later request, so the ceiling is what stops a long call from growing
 * its own context until the provider rejects it.
 */
export const MAX_SIGHT_KEEP_LATEST_FRAMES = 6;

export const SightConfigSchema = z
  .object({
    keepLatestFrames: z
      .number({ error: "sight.keepLatestFrames must be a number" })
      .int("sight.keepLatestFrames must be an integer")
      .default(KEEP_LATEST_SIGHT_FRAMES)
      .describe(
        `How many of the newest camera frames a live-voice call keeps in the model's context as images; older frames become timestamped text stubs. Clamped to ${MIN_SIGHT_KEEP_LATEST_FRAMES}..${MAX_SIGHT_KEEP_LATEST_FRAMES} when read.`,
      ),
  })
  .describe("Ambient camera frames sampled during a live-voice call");

export type SightConfig = z.infer<typeof SightConfigSchema>;
