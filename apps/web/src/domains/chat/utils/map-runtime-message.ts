import { runtimeAttachmentsToDisplay } from "@/domains/chat/utils/attachment-mapping";
import { parseAttachmentSummariesFromContent } from "@/domains/chat/utils/parse-attachment-summaries";
import { segmentsToPlainText } from "@/domains/chat/utils/segments-to-plain-text";
import type {
  DisplayAttachment,
  DisplayMessage,
  SlackRuntimeMessage,
} from "@/domains/chat/types/types";
import { mapRuntimeToolCalls, normalizeContentOrder, normalizeTextSegments, type RuntimeMessage } from "@/domains/chat/api/messages";

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
  parsedAttachments: DisplayAttachment[] | undefined;
  structuredAttachments: DisplayAttachment[] | undefined;
  normalizedSegments:
    | Array<{ type: string; content: string; [key: string]: unknown }>
    | undefined;
  normalizedContentOrder: Array<{ type: string; id: string }> | undefined;
  toolCalls: ReturnType<typeof mapRuntimeToolCalls> | undefined;
  slackMessage: SlackRuntimeMessage | undefined;
  timestamp: number | undefined;
  thinkingSegments: string[] | undefined;
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
 * fields into display-ready values. Text segments are normalized and have their
 * inlined attachment summary lines stripped, fallback attachment stubs are
 * reconstructed from those lines, structured attachments are mapped from the
 * daemon's metadata, and timestamps are coerced to epoch ms.
 */
export function prepareServerMessage(m: RuntimeMessage): PreparedRuntimeMessage {
  const structuredAttachments =
    m.attachments && m.attachments.length > 0
      ? runtimeAttachmentsToDisplay(m.attachments)
      : undefined;

  // Clean each text segment individually and harvest fallback attachment
  // stubs from the cleaned-off lines. `renderHistoryContent` in the daemon
  // appends `[File attachment]` summary lines to whichever text segment is
  // open at the end of the message body, which can be ANY segment when text
  // is interleaved with `tool_use` / `ui_surface` blocks. Patching only
  // segments[0] (as a prior implementation did) left raw "[File attachment]"
  // text in trailing segments, which the transcript renderer then printed
  // into chat bubbles. LUM-1527.
  const rawSegments = normalizeTextSegments(m.textSegments as unknown[]);
  const parsedAttachmentsAccum: DisplayAttachment[] = [];
  const normalizedSegments = rawSegments
    ? rawSegments.map((seg) => {
        const { cleanedContent: segCleaned, attachments: segAttachments } =
          parseAttachmentSummariesFromContent(seg.content);
        if (segAttachments) {
          parsedAttachmentsAccum.push(...segAttachments);
        }
        return segCleaned === seg.content
          ? seg
          : { ...seg, content: segCleaned };
      })
    : undefined;

  // Re-index the synthesized `rehydrated:` ids so they stay unique even in
  // the (unusual) case where summary lines span more than one segment.
  const parsedAttachments =
    parsedAttachmentsAccum.length > 0
      ? parsedAttachmentsAccum.map((att, i) => ({
          ...att,
          id: `rehydrated:${i}`,
        }))
      : undefined;

  const normalizedContentOrder = normalizeContentOrder(
    m.contentOrder as unknown[],
  );

  const toolCalls =
    m.toolCalls && m.toolCalls.length > 0
      ? mapRuntimeToolCalls(m.toolCalls, m.id)
      : undefined;

  const timestamp = parseRuntimeTimestamp(m.timestamp);

  const thinkingSegments =
    m.thinkingSegments && m.thinkingSegments.length > 0
      ? m.thinkingSegments
      : undefined;

  return {
    parsedAttachments,
    structuredAttachments,
    normalizedSegments,
    normalizedContentOrder,
    toolCalls,
    slackMessage: m.slackMessage,
    timestamp,
    thinkingSegments,
  };
}

/**
 * Map a `RuntimeMessage` to a `DisplayMessage`.
 *
 * Used by `history.ts` for initial page loads where there is no local state
 * to merge. For reconciliation (where local state must be preserved), use
 * `prepareServerMessage` directly and apply the merge overlay.
 */
export function mapRuntimeToDisplayMessage(m: RuntimeMessage): DisplayMessage {
  const prepared = prepareServerMessage(m);

  const msg: DisplayMessage = {
    id: m.id,
    role: m.role,
  };
  if (m.mergedMessageIds?.length) msg.mergedMessageIds = m.mergedMessageIds;
  if (m.surfaces) msg.surfaces = m.surfaces;
  if (prepared.normalizedSegments) msg.textSegments = prepared.normalizedSegments;
  if (prepared.normalizedContentOrder) msg.contentOrder = prepared.normalizedContentOrder;
  if (prepared.thinkingSegments) msg.thinkingSegments = prepared.thinkingSegments;
  if (m.metadata) msg.metadata = m.metadata;
  if (m.subagentNotification) msg.isSubagentNotification = true;
  if (prepared.slackMessage) msg.slackMessage = prepared.slackMessage;
  if (prepared.toolCalls) msg.toolCalls = prepared.toolCalls;
  if (prepared.timestamp != null) msg.timestamp = prepared.timestamp;

  const attachments = prepared.structuredAttachments ?? prepared.parsedAttachments;
  if (attachments) msg.attachments = attachments;

  return msg;
}

/**
 * Derive the cleaned, flat plain-text body of a raw `RuntimeMessage`.
 *
 * Normalizes and cleans the wire `textSegments` (stripping inlined
 * attachment summary lines) and joins them with the daemon's spacing rules,
 * yielding text identical to what `DisplayMessage` rows expose via
 * `segmentsToPlainText`. Used where a raw server message must be compared
 * against a display row (reconciliation) or summarized (diagnostics, inspector).
 */
export function runtimeMessagePlainText(m: RuntimeMessage): string {
  return segmentsToPlainText(prepareServerMessage(m).normalizedSegments);
}
