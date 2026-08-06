/**
 * Typed, validated representation of a Slack message's inline mention source:
 * the verbatim mention markup plus the label snapshot resolved at ingress,
 * with explicit workspace/install scope and a persist-time projectability
 * fact.
 *
 * This module is pure and has no persistence or network callers. It defines
 * the v1 contract (LUM-3023): consumers project readable text from persisted
 * source data instead of trusting a one-shot ingress render. Projection is
 * deterministic and snapshot-first; live lookups never participate at render
 * time.
 *
 * Scope note: a Slack channel or user id is only meaningful within one
 * workspace. `installTeamId` records the workspace the labels were resolved
 * under when the ingress payload carries it; `null` means the deployment's
 * single install implicitly defines the scope. Persisting cross-workspace
 * data is blocked until ingress can prove scope (see the LUM-3023 plan's
 * open blockers); nothing in this module resolves ids against any workspace.
 */

import {
  extractSlackChannelReferenceIds,
  extractSlackUserMentionIds,
  renderSlackTextForModel,
  sanitizeSlackLabel,
} from "@vellumai/slack-text";

export interface SlackMentionLabelMaps {
  /** Slack user id (`U…`/`W…`) to sanitized display label. */
  users: Record<string, string>;
  /** Slack conversation id (`C…`/`G…`/`D…`) to sanitized channel name. */
  channels: Record<string, string>;
}

export interface SlackMentionSourceV1 {
  /** Schema version marker; readers must reject unknown versions. */
  v: 1;
  /**
   * Workspace the labels were resolved under, when ingress supplied it.
   * `null` means the install's implicit single-workspace scope.
   */
  installTeamId: string | null;
  /** The verbatim Slack event text, mention markup intact. */
  rawText: string;
  /** Ingress-resolved labels, filtered to ids present in `rawText`. */
  labels: SlackMentionLabelMaps;
  /**
   * True when the stored message body is exactly the render of
   * (`rawText`, `labels`), computed once at persist time. Only projectable
   * rows may ever be re-rendered; false covers composed bodies (e.g. voice
   * transcription prepended at ingress), edits that diverged, and any
   * unexpected mismatch.
   */
  projectable: boolean;
}

/**
 * Upper bound on persisted raw text, in UTF-8 bytes. Oversize input is
 * REJECTED (the whole source is dropped), never truncated: truncation can
 * split a mention token and silently change what the text parses as.
 */
export const MENTION_RAW_TEXT_MAX_BYTES = 8192;

/** Per-label character cap, matching the renderer's sanitizer budget. */
export const MENTION_LABEL_MAX_CHARS = 200;

/**
 * Per-map entry cap. Overflow drops entries deterministically from the end
 * of the sorted key order, so the same input always persists the same maps.
 */
export const MENTION_LABEL_MAP_MAX_ENTRIES = 32;

const CHANNEL_ID_RE = /^[CDG][A-Z0-9]{1,31}$/;
const USER_ID_RE = /^[UW][A-Z0-9]{1,31}$/;
const TEAM_ID_RE = /^[TE][A-Z0-9]{1,31}$/;

/**
 * Sanitize a label for persistence: the shared renderer normalization from
 * `@vellumai/slack-text` (single source of truth, so persisted labels can
 * never drift from render-time semantics), plus the persistence-only
 * bounds this module owns: well-formedness rejection and a length cap.
 * Returns `undefined` when the input is malformed or nothing usable remains.
 */
export function sanitizeMentionLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || !isWellFormedString(value)) {
    return undefined;
  }
  const normalized = sanitizeSlackLabel(value);
  if (!normalized) {
    return undefined;
  }
  // Truncate on code-point boundaries: a UTF-16 `slice` can split a
  // surrogate pair and persist a lone surrogate, violating the same
  // well-formedness rule this module enforces on rawText.
  const sanitized = [...normalized]
    .slice(0, MENTION_LABEL_MAX_CHARS)
    .join("")
    .trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Reject strings carrying unpaired surrogates (not valid UTF-8 material). */
function isWellFormedString(value: string): boolean {
  const withIsWellFormed = value as string & { isWellFormed?: () => boolean };
  if (typeof withIsWellFormed.isWellFormed === "function") {
    return withIsWellFormed.isWellFormed();
  }
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function buildLabelMap(
  ids: readonly string[],
  provided: Record<string, unknown> | undefined,
  idPattern: RegExp,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!provided) {
    return out;
  }
  // Deterministic overflow: iterate ids in sorted order and stop at the cap.
  const sortedIds = [...new Set(ids)].sort();
  for (const id of sortedIds) {
    if (Object.keys(out).length >= MENTION_LABEL_MAP_MAX_ENTRIES) {
      break;
    }
    if (!idPattern.test(id)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(provided, id)) {
      continue;
    }
    const label = sanitizeMentionLabel(provided[id]);
    // An id-shaped "label" is not a resolution; the renderer treats it as
    // unresolved, so persisting it would only waste bytes.
    if (!label || label === id) {
      continue;
    }
    out[id] = label;
  }
  return out;
}

export interface BuildSlackMentionSourceInput {
  /** The verbatim Slack event text. */
  rawText: unknown;
  /** Ingress-resolved user labels keyed by user id, unvalidated. */
  userLabels?: Record<string, unknown>;
  /** Ingress-resolved channel labels keyed by conversation id, unvalidated. */
  channelLabels?: Record<string, unknown>;
  /** Workspace scope the labels were resolved under, when ingress knows it. */
  installTeamId?: unknown;
  /**
   * The message body text as it will be persisted, used to compute
   * `projectable` (exact-render equality).
   */
  storedBodyText: string;
}

/**
 * Validate ingress inputs into a persistable `SlackMentionSourceV1`, or
 * `undefined` when the text carries no mention tokens or fails validation.
 * All bounds are enforced here regardless of how trusted the caller is:
 * this function is the persistence boundary for mention data.
 */
export function buildSlackMentionSource(
  input: BuildSlackMentionSourceInput,
): SlackMentionSourceV1 | undefined {
  const { rawText, storedBodyText } = input;
  if (typeof rawText !== "string" || rawText.length === 0) {
    return undefined;
  }
  if (!isWellFormedString(rawText)) {
    return undefined;
  }
  if (utf8ByteLength(rawText) > MENTION_RAW_TEXT_MAX_BYTES) {
    return undefined;
  }

  const userIds = extractSlackUserMentionIds(rawText);
  const channelIds = extractSlackChannelReferenceIds(rawText);
  if (userIds.length === 0 && channelIds.length === 0) {
    return undefined;
  }

  const labels: SlackMentionLabelMaps = {
    users: buildLabelMap(userIds, input.userLabels, USER_ID_RE),
    channels: buildLabelMap(channelIds, input.channelLabels, CHANNEL_ID_RE),
  };

  const installTeamId =
    typeof input.installTeamId === "string" &&
    TEAM_ID_RE.test(input.installTeamId)
      ? input.installTeamId
      : null;

  return {
    v: 1,
    installTeamId,
    rawText,
    labels,
    projectable:
      renderMentionSourceText(rawText, labels) === storedBodyText.trim(),
  };
}

/**
 * Parse a persisted (or wire) value back into a validated
 * `SlackMentionSourceV1`. Unknown versions, malformed shapes, and
 * out-of-bounds data return `undefined` so readers fall back to stored text.
 */
export function readSlackMentionSource(
  value: unknown,
): SlackMentionSourceV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1) {
    return undefined;
  }
  // A malformed labels container is a rejected shape, not "no labels": a
  // value that lost its maps but kept `projectable: true` must fall back to
  // stored text rather than project fallback labels over it.
  const labels = asRecord(record.labels);
  const users = asRecord(labels?.users);
  const channels = asRecord(labels?.channels);
  if (!labels || !users || !channels) {
    return undefined;
  }
  const rebuilt = buildSlackMentionSource({
    rawText: record.rawText,
    userLabels: users,
    channelLabels: channels,
    installTeamId: record.installTeamId ?? undefined,
    // `projectable` is a stored fact; re-deriving it needs the stored body,
    // which readers do not always have. Preserve the persisted flag but only
    // when it is a real boolean.
    storedBodyText: "",
  });
  if (!rebuilt || typeof record.projectable !== "boolean") {
    return undefined;
  }
  return { ...rebuilt, projectable: record.projectable };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function renderMentionSourceText(
  rawText: string,
  labels: SlackMentionLabelMaps,
): string {
  return renderSlackTextForModel(rawText, {
    userLabels: labels.users,
    channelLabels: labels.channels,
  }).trim();
}

/**
 * Pure, synchronous projection: render the persisted mention source when the
 * row is projectable, otherwise return the stored text unchanged. No live
 * cache or lookup participates; historical messages render the historical
 * snapshot. Callers apply untrusted-content fencing AFTER this function
 * (render-then-fence), matching the ingress pipeline's order.
 */
export function projectSlackMentionText(
  source: SlackMentionSourceV1 | undefined,
  storedText: string,
): string {
  if (!source || !source.projectable) {
    return storedText;
  }
  const projected = renderMentionSourceText(source.rawText, source.labels);
  return projected.length > 0 ? projected : storedText;
}
