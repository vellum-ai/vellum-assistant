import { z } from "zod";

/**
 * Settings for media the assistant keeps in a request's history.
 *
 * `payloadCap` overrides the byte marks of the hysteresis band the outbound
 * sanitizer holds retained tool-result media under
 * (`providers/media-payload-limits.ts`). The shipped marks assume the
 * transport is unknown and sit under the tightest documented request limit,
 * Gemini's 20 MB. An installation whose conversations run on one known
 * transport can raise them: Anthropic accepts 32 MB requests, which leaves
 * about 22 MB high and 14 MB low after the same reserves for the current
 * step's screenshot and the request's text. Marks above what the transport
 * accepts are not fatal, but the first request over the limit is rejected
 * before the reactive overflow path trims it.
 */
export const MediaPayloadCapSchema = z
  .object({
    highMb: z
      .number({ error: "media.payloadCap.highMb must be a number" })
      .positive("media.payloadCap.highMb must be greater than 0")
      .describe(
        "Retained media, in MB of base64, above which the oldest file-read media is dropped from the request.",
      ),
    lowMb: z
      .number({ error: "media.payloadCap.lowMb must be a number" })
      .positive("media.payloadCap.lowMb must be greater than 0")
      .describe(
        "Once dropping starts, it continues until retained media is under this many MB; must be below highMb.",
      ),
  })
  .refine((cap) => cap.lowMb < cap.highMb, {
    error: "media.payloadCap.lowMb must be below media.payloadCap.highMb",
  });

export const MediaConfigSchema = z
  .object({
    payloadCap: MediaPayloadCapSchema.optional().describe(
      "Byte marks for retained tool-result media in a request. Omit to use the shipped marks, which suit any transport.",
    ),
  })
  .describe("Media kept in the model's context across turns");

export type MediaConfig = z.infer<typeof MediaConfigSchema>;
