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
 * Slack transcript rendering and backfill paths persist and read this metadata
 * to reconstruct thread order, reactions, edits, deletes, and lightweight
 * Slack file markers. Transient late-join notices are current-turn runtime
 * context only and do not become durable message metadata.
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
  channelName: z.string().optional(),
  channelTs: z.string(),
  threadTs: z.string().optional(),
  displayName: z.string().optional(),
  actorExternalUserId: z.string().optional(),
  actorTimezone: z.string().optional(),
  actorTimezoneLabel: z.string().optional(),
  actorTimezoneOffsetSeconds: z.number().optional(),
  timestampTimezone: z.string().optional(),
  timestampTimezoneLabel: z.string().optional(),
  speakerTimezoneLabel: z.string().optional(),
  eventKind: z.enum(["message", "reaction"]),
  reaction: slackReactionMetadataSchema.optional(),
  editedAt: z.number().optional(),
  deletedAt: z.number().optional(),
  slackFiles: z.array(slackFileMetadataSchema).optional(),
});

export type SlackReactionMetadata = z.infer<typeof slackReactionMetadataSchema>;
export type SlackFileMetadata = z.infer<typeof slackFileMetadataSchema>;
export type SlackMessageMetadata = z.infer<typeof slackMessageMetadataSchema>;

type SlackTimezoneMetadata = Pick<
  SlackMessageMetadata,
  | "actorTimezone"
  | "actorTimezoneLabel"
  | "actorTimezoneOffsetSeconds"
  | "timestampTimezone"
  | "timestampTimezoneLabel"
  | "speakerTimezoneLabel"
>;
type SlackTimezoneMetadataInput = Omit<
  Partial<SlackTimezoneMetadata>,
  "actorTimezoneOffsetSeconds"
> & {
  actorTimezoneOffsetSeconds?: unknown;
};

const COMMON_SLACK_TIMEZONE_LABEL_BY_IANA = new Map<string, string>([
  ["America/New_York", "ET"],
  ["America/Detroit", "ET"],
  ["America/Indiana/Indianapolis", "ET"],
  ["America/Kentucky/Louisville", "ET"],
  ["America/Toronto", "ET"],
  ["America/Montreal", "ET"],
  ["America/Chicago", "CT"],
  ["America/Winnipeg", "CT"],
  ["America/Mexico_City", "CT"],
  ["America/Denver", "MT"],
  ["America/Boise", "MT"],
  ["America/Phoenix", "MT"],
  ["America/Edmonton", "MT"],
  ["America/Los_Angeles", "PT"],
  ["America/Vancouver", "PT"],
  ["America/Tijuana", "PT"],
]);

const COMPACT_SLACK_TIMEZONE_LABEL_BY_NAME = new Map<string, string>([
  ["EASTERN TIME", "ET"],
  ["EASTERN STANDARD TIME", "ET"],
  ["EASTERN DAYLIGHT TIME", "ET"],
  ["EST", "ET"],
  ["EDT", "ET"],
  ["CENTRAL TIME", "CT"],
  ["CENTRAL STANDARD TIME", "CT"],
  ["CENTRAL DAYLIGHT TIME", "CT"],
  ["CST", "CT"],
  ["CDT", "CT"],
  ["MOUNTAIN TIME", "MT"],
  ["MOUNTAIN STANDARD TIME", "MT"],
  ["MOUNTAIN DAYLIGHT TIME", "MT"],
  ["MST", "MT"],
  ["MDT", "MT"],
  ["PACIFIC TIME", "PT"],
  ["PACIFIC STANDARD TIME", "PT"],
  ["PACIFIC DAYLIGHT TIME", "PT"],
  ["PST", "PT"],
  ["PDT", "PT"],
]);

const slackShortTimeZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function compactStoredSlackTimezoneLabel(
  label: string | null | undefined,
): string | null {
  const trimmed = label?.trim();
  if (!trimmed) return null;
  return (
    COMPACT_SLACK_TIMEZONE_LABEL_BY_NAME.get(trimmed.toUpperCase()) ?? trimmed
  );
}

function getSlackShortTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = slackShortTimeZoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    });
    slackShortTimeZoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function extractSlackShortTimeZoneName(
  timeZone: string,
  nowMs: number,
): string | null {
  try {
    const part = getSlackShortTimeZoneFormatter(timeZone)
      .formatToParts(new Date(nowMs))
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? null;
  } catch {
    return null;
  }
}

export function formatSlackTimezoneLabel(
  timeZone: string | null | undefined,
  opts: { persistedLabel?: string | null; nowMs?: number } = {},
): string | null {
  const persisted = compactStoredSlackTimezoneLabel(opts.persistedLabel);
  if (persisted) return persisted;

  const trimmedTimezone = timeZone?.trim();
  if (!trimmedTimezone) return null;
  const mapped = COMMON_SLACK_TIMEZONE_LABEL_BY_IANA.get(trimmedTimezone);
  if (mapped) return mapped;
  return (
    extractSlackShortTimeZoneName(trimmedTimezone, opts.nowMs ?? Date.now()) ??
    trimmedTimezone
  );
}

function trimmedOptionalString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildSlackTimezoneMetadata(
  input: SlackTimezoneMetadataInput,
): Partial<SlackTimezoneMetadata> {
  const actorTimezone = trimmedOptionalString(input.actorTimezone);
  const actorTimezoneLabel = trimmedOptionalString(input.actorTimezoneLabel);
  const timestampTimezone = trimmedOptionalString(input.timestampTimezone);
  const timestampTimezoneLabel = trimmedOptionalString(
    input.timestampTimezoneLabel,
  );
  const speakerTimezoneLabel = trimmedOptionalString(
    input.speakerTimezoneLabel,
  );
  const actorTimezoneOffsetSeconds =
    typeof input.actorTimezoneOffsetSeconds === "number" &&
    Number.isFinite(input.actorTimezoneOffsetSeconds)
      ? input.actorTimezoneOffsetSeconds
      : undefined;
  return {
    ...(actorTimezone ? { actorTimezone } : {}),
    ...(actorTimezoneLabel ? { actorTimezoneLabel } : {}),
    ...(actorTimezoneOffsetSeconds !== undefined
      ? { actorTimezoneOffsetSeconds }
      : {}),
    ...(timestampTimezone ? { timestampTimezone } : {}),
    ...(timestampTimezoneLabel ? { timestampTimezoneLabel } : {}),
    ...(speakerTimezoneLabel ? { speakerTimezoneLabel } : {}),
  };
}

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

export function readSlackMetadataFromMessageMetadata(
  metadata: string | null | undefined,
  opts?: { allowFlatLegacy?: boolean },
): SlackMessageMetadata | null {
  if (!metadata) return null;

  let parent: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parent = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  if (!parent) return null;

  const nested = parent.slackMeta;
  if (typeof nested === "string") {
    const parsedNested = readSlackMetadata(nested);
    if (parsedNested) return parsedNested;
  }

  return opts?.allowFlatLegacy ? readSlackMetadata(metadata) : null;
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
