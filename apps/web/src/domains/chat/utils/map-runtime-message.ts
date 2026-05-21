import { runtimeAttachmentsToDisplay } from "@/domains/chat/utils/attachment-mapping.js";
import { parseAttachmentSummariesFromContent } from "@/domains/chat/utils/parse-attachment-summaries.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";
import type {
  DisplayAttachment,
  DisplayMessage,
  SlackRuntimeMessage,
} from "@/domains/chat/types/types.js";
import { mapRuntimeToolCalls, normalizeContentOrder, normalizeTextSegments, type RuntimeMessage } from "@/domains/chat/api/messages.js";

/**
 * Intermediate representation of a RuntimeMessage after all server-side fields
 * have been parsed, cleaned, and normalized. Both `history.ts` (initial load)
 * and `reconcile.ts` (periodic server sync) must go through
 * `prepareServerMessage` to produce this — the single-entry-point design
 * prevents the class of bug where one code path forgets a transformation step
 * (e.g. content cleaning, segment normalization).
 *
 * Reconcile applies its merge overlay (local toolCalls, surfaces, attachment
 * priority chain) on top of these prepared fields. History uses them directly
 * via `mapRuntimeToDisplayMessage`.
 */
export interface PreparedRuntimeMessage {
  cleanedContent: string;
  parsedAttachments: DisplayAttachment[] | undefined;
  structuredAttachments: DisplayAttachment[] | undefined;
  normalizedSegments:
    | Array<{ type: string; content: string; [key: string]: unknown }>
    | undefined;
  normalizedContentOrder: Array<{ type: string; id: string }> | undefined;
  toolCalls: ReturnType<typeof mapRuntimeToolCalls> | undefined;
  slackMessage: SlackRuntimeMessage | undefined;
  timestamp: number | undefined;
}

/**
 * Coerce a runtime timestamp (number, ISO string, or missing) to epoch ms.
 * The daemon sends timestamps as ISO strings in history payloads but as
 * numbers in SSE events; this normalizes both to a consistent number.
 */
export function parseRuntimeTimestamp(
  ts: unknown,
): number | undefined {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Parse and normalize all server-side fields from a `RuntimeMessage`.
 *
 * This is the single source of truth for interpreting a RuntimeMessage's raw
 * fields into display-ready values. Content is cleaned (attachment summary
 * lines stripped), text segments are normalized with the first segment synced
 * to cleaned content, attachments are mapped from structured metadata, and
 * timestamps are coerced to epoch ms.
 */
export function prepareServerMessage(m: RuntimeMessage): PreparedRuntimeMessage {
  const { cleanedContent, attachments: parsedAttachments } =
    parseAttachmentSummariesFromContent(m.content);

  const structuredAttachments =
    m.attachments && m.attachments.length > 0
      ? runtimeAttachmentsToDisplay(m.attachments)
      : undefined;

  // Clean each text segment individually. `renderHistoryContent` in the
  // daemon appends `[File attachment]` summary lines to whichever text
  // segment is open at the end of the message body, which can be ANY
  // segment when text is interleaved with `tool_use` / `ui_surface`
  // blocks. Patching only segments[0] (as a prior implementation did)
  // left raw "[File attachment]" text in trailing segments, which the
  // transcript renderer then printed into chat bubbles. LUM-1527.
  const rawSegments = normalizeTextSegments(m.textSegments as unknown[]);
  const normalizedSegments = rawSegments
    ? rawSegments.map((seg) => {
        const { cleanedContent: segCleaned } =
          parseAttachmentSummariesFromContent(seg.content);
        return segCleaned === seg.content
          ? seg
          : { ...seg, content: segCleaned };
      })
    : undefined;

  const normalizedContentOrder = normalizeContentOrder(
    m.contentOrder as unknown[],
  );

  const toolCalls =
    m.toolCalls && m.toolCalls.length > 0
      ? mapRuntimeToolCalls(m.toolCalls, m.id)
      : undefined;

  const timestamp = parseRuntimeTimestamp(m.timestamp);

  return {
    cleanedContent,
    parsedAttachments,
    structuredAttachments,
    normalizedSegments,
    normalizedContentOrder,
    toolCalls,
    slackMessage: m.slackMessage,
    timestamp,
  };
}

/**
 * Map a `RuntimeMessage` to a `DisplayMessage` with a fresh `stableId`.
 *
 * Used by `history.ts` for initial page loads where there is no local state
 * to merge. For reconciliation (where local state must be preserved), use
 * `prepareServerMessage` directly and apply the merge overlay.
 */
export function mapRuntimeToDisplayMessage(m: RuntimeMessage): DisplayMessage {
  const prepared = prepareServerMessage(m);

  const msg: DisplayMessage = {
    id: m.id,
    ...(m.daemonMessageId ? { daemonMessageId: m.daemonMessageId } : {}),
    role: m.role,
    content: prepared.cleanedContent,
    stableId: newStableId("server"),
  };
  if (m.surfaces) msg.surfaces = m.surfaces;
  if (prepared.normalizedSegments) msg.textSegments = prepared.normalizedSegments;
  if (prepared.normalizedContentOrder) msg.contentOrder = prepared.normalizedContentOrder;
  if (m.metadata) msg.metadata = m.metadata;
  if (m.subagentNotification) msg.isSubagentNotification = true;
  if (prepared.slackMessage) msg.slackMessage = prepared.slackMessage;
  if (prepared.toolCalls) msg.toolCalls = prepared.toolCalls;
  if (prepared.timestamp != null) msg.timestamp = prepared.timestamp;

  const attachments = prepared.structuredAttachments ?? prepared.parsedAttachments;
  if (attachments) msg.attachments = attachments;

  return msg;
}
