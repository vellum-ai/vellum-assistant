/**
 * Typed Slack message metadata stored in the `messages.metadata` column for
 * thread-aware context rendering.
 *
 * The full metadata column may contain other unrelated keys; Slack-specific
 * metadata lives under a `slackMeta` sub-key written via `writeSlackMetadata`
 * and read via `readSlackMetadata`. `mergeSlackMetadata` performs partial
 * updates (for edits, deletions, display-name refreshes) without disturbing
 * unrelated fields.
 *
 * This file is a pure library addition — no consumers wire into it yet; that
 * happens in later PRs of the slack-thread-aware-context plan.
 */

export type SlackEventKind = "message" | "reaction";

export interface SlackReactionMetadata {
  readonly emoji: string;
  readonly actorDisplayName?: string;
  readonly targetChannelTs: string;
  readonly op: "added" | "removed";
}

export interface SlackMessageMetadata {
  readonly source: "slack";
  readonly channelId: string;
  readonly channelTs: string; // Slack's own ts for this record
  readonly threadTs?: string; // parent ts, absent for top-level
  readonly displayName?: string; // cached sender name
  readonly eventKind: SlackEventKind; // "message" or "reaction"
  readonly reaction?: SlackReactionMetadata;
  readonly editedAt?: number;
  readonly deletedAt?: number;
}

/**
 * Parse a JSON string into `SlackMessageMetadata`. Returns `null` on parse
 * error, when the payload is not an object, or when `source !== "slack"`.
 *
 * Tolerates `null` and `undefined` inputs (returns `null`) so callers can pass
 * raw column values without pre-checks.
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
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.source !== "slack") {
    return null;
  }
  if (typeof obj.channelId !== "string" || typeof obj.channelTs !== "string") {
    return null;
  }
  if (obj.eventKind !== "message" && obj.eventKind !== "reaction") {
    return null;
  }
  return obj as unknown as SlackMessageMetadata;
}

/**
 * Serialize `SlackMessageMetadata` to a JSON string suitable for storage in
 * the `messages.metadata` column (or as a sub-value within a larger metadata
 * envelope).
 */
export function writeSlackMetadata(meta: SlackMessageMetadata): string {
  return JSON.stringify(meta);
}

/**
 * Apply a partial patch to existing serialized Slack metadata. Used for
 * incremental updates such as marking a message edited or deleted, or
 * refreshing a cached display name.
 *
 * If `existing` is `null`/`undefined` or fails to parse as Slack metadata,
 * the patch must contain enough fields to construct a valid
 * `SlackMessageMetadata` (`source`, `channelId`, `channelTs`, `eventKind`).
 * The function does not validate that case beyond what `JSON.stringify`
 * accepts — readers will reject invalid output via `readSlackMetadata`.
 *
 * Unrelated fields on the existing metadata are preserved; the patch's
 * defined fields override them. `undefined` fields in the patch are ignored
 * (use a sentinel like `0` if a numeric field needs an explicit reset).
 */
export function mergeSlackMetadata(
  existing: string | null | undefined,
  patch: Partial<SlackMessageMetadata>,
): string {
  const base = readSlackMetadata(existing) ?? {};
  const cleanedPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      cleanedPatch[key] = value;
    }
  }
  const merged = { ...base, ...cleanedPatch, source: "slack" as const };
  return JSON.stringify(merged);
}
