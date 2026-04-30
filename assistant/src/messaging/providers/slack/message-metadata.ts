import { z } from "zod";

/**
 * Typed Slack message metadata stored flat in the `messages.metadata` column
 * alongside whatever other top-level keys the broader metadata envelope
 * carries (see `messageMetadataSchema` in `memory/conversation-crud.ts`).
 *
 * Slack-specific fields are serialized directly onto the top-level object
 * (no sub-key); `source: "slack"` acts as the discriminator. `readSlackMetadata`
 * parses and validates those fields via Zod; `writeSlackMetadata` emits a
 * Slack-only blob for fresh writes; `mergeSlackMetadata` patches Slack fields
 * while preserving unrelated keys on the existing JSON.
 *
 * This file is a pure library addition — no consumers wire into it yet; that
 * happens in later PRs of the slack-thread-aware-context plan.
 */

export type SlackEventKind = "message" | "reaction";

const slackReactionMetadataSchema = z.object({
  emoji: z.string(),
  actorDisplayName: z.string().optional(),
  targetChannelTs: z.string(),
  op: z.enum(["added", "removed"]),
});

const slackFileMetadataSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  mimetype: z.string().optional(),
});

export const slackMessageMetadataSchema = z.object({
  source: z.literal("slack"),
  channelId: z.string(),
  channelTs: z.string(),
  threadTs: z.string().optional(),
  displayName: z.string().optional(),
  eventKind: z.enum(["message", "reaction"]),
  reaction: slackReactionMetadataSchema.optional(),
  editedAt: z.number().optional(),
  deletedAt: z.number().optional(),
  isBackfill: z.boolean().optional(),
  backfillReason: z
    .enum(["thread_late_join", "thread_delta", "dm_cold_start"])
    .optional(),
  backfillOmittedCount: z.number().optional(),
  backfillOmittedMiddle: z.boolean().optional(),
  slackFiles: z.array(slackFileMetadataSchema).optional(),
});

export type SlackReactionMetadata = z.infer<typeof slackReactionMetadataSchema>;
export type SlackFileMetadata = z.infer<typeof slackFileMetadataSchema>;
export type SlackMessageMetadata = z.infer<typeof slackMessageMetadataSchema>;

/**
 * Parse a JSON string into `SlackMessageMetadata`. Returns `null` on parse
 * error, on non-object payloads, when `source !== "slack"`, or when any
 * field fails Zod validation (including malformed optional fields like a
 * non-string `threadTs` or a nested `reaction` with the wrong `op`).
 *
 * Tolerates `null` and `undefined` inputs (returns `null`) so callers can pass
 * raw column values without pre-checks. Unknown top-level keys (from unrelated
 * metadata co-tenants) are stripped from the returned object.
 */
export function readSlackMetadata(
  raw: string | null | undefined,
): SlackMessageMetadata | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = slackMessageMetadataSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Serialize `SlackMessageMetadata` to a JSON string suitable for a fresh
 * write to the `messages.metadata` column. Use `mergeSlackMetadata` when an
 * existing blob may already carry unrelated keys that must be preserved.
 */
export function writeSlackMetadata(meta: SlackMessageMetadata): string {
  return JSON.stringify(meta);
}

function parseRawObject(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (raw === null || raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty base
  }
  return {};
}

/**
 * Apply a partial Slack patch to an existing metadata blob. Preserves every
 * top-level key on the existing JSON (including unrelated non-Slack fields
 * written by other subsystems — `userMessageChannel`, `provenanceTrustClass`,
 * etc.), overlays patch fields, and forces `source: "slack"` so subsequent
 * `readSlackMetadata` calls accept the result.
 *
 * `undefined` patch fields are ignored (use a sentinel like `0` to explicitly
 * reset a numeric field). If `existing` is `null`/`undefined` or does not
 * parse as a JSON object, the base is empty and the patch must supply the
 * required Slack fields (`channelId`, `channelTs`, `eventKind`) for the
 * output to round-trip through `readSlackMetadata`.
 */
export function mergeSlackMetadata(
  existing: string | null | undefined,
  patch: Partial<SlackMessageMetadata>,
): string {
  const base = parseRawObject(existing);
  const cleanedPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      cleanedPatch[key] = value;
    }
  }
  return JSON.stringify({ ...base, ...cleanedPatch, source: "slack" });
}
