import type {
  ConversationMessage,
  ConversationMessageSurface,
} from "@vellumai/assistant-api";
import { runtimeAttachmentsToDisplay } from "@/domains/chat/utils/attachment-mapping";
import { parseAttachmentSummariesFromContent } from "@/domains/chat/utils/parse-attachment-summaries";
import type {
  DisplayAttachment,
  DisplayMessage,
  Surface,
} from "@/domains/chat/types/types";
import {
  mapRuntimeToolCalls,
  normalizeContentBlocks,
  normalizeContentOrder,
} from "@/domains/chat/api/messages";

/**
 * Narrow the wire surface `display` (an open string) to the display union.
 * The daemon only emits "inline" / "panel" (or omits it); any other value
 * maps to undefined, which the renderer treats as an unset display mode.
 */
function narrowSurfaceDisplay(display: string | undefined): Surface["display"] {
  return display === "inline" || display === "panel" ? display : undefined;
}

/**
 * Adapt a single wire `ConversationMessageSurface` onto the display `Surface`
 * shape, narrowing the open `display` string to the placement union. The
 * transcript render path projects a surface straight off its `contentBlocks`
 * surface block through this helper; `mapServerSurfaces` maps the positional
 * `surfaces` array through it.
 */
export function wireSurfaceToDisplay(s: ConversationMessageSurface): Surface {
  return {
    surfaceId: s.surfaceId,
    surfaceType: s.surfaceType,
    title: s.title,
    data: s.data,
    actions: s.actions,
    display: narrowSurfaceDisplay(s.display),
    completed: s.completed,
    completionSummary: s.completionSummary,
    toolCallId: s.toolCallId,
  };
}

/** Adapt wire surfaces onto the display `Surface` shape. */
export function mapServerSurfaces(
  surfaces: readonly ConversationMessageSurface[],
): Surface[] {
  return surfaces.map(wireSurfaceToDisplay);
}

/**
 * Coerce a runtime timestamp (number, ISO string, or missing) to epoch ms.
 * The daemon sends timestamps as ISO strings in history payloads but as
 * numbers in SSE events; this normalizes both to a consistent number.
 */
function parseRuntimeTimestamp(ts: unknown): number | undefined {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Clean each wire text segment of its inlined `[File attachment]` summary
 * lines, returning the cleaned segments together with any attachment stubs
 * harvested from the stripped lines.
 *
 * `renderHistoryContent` in the daemon appends `[File attachment]` summary
 * lines to whichever text segment is open at the end of the message body,
 * which can be ANY segment when text is interleaved with `tool_use` /
 * `ui_surface` blocks. Cleaning only segments[0] (as a prior implementation
 * did) left raw "[File attachment]" text in trailing segments, which the
 * transcript renderer then printed into chat bubbles (LUM-1527). The
 * synthesized `rehydrated:` ids are re-indexed so they stay unique even in the
 * (unusual) case where summary lines span more than one segment.
 */
function cleanTextSegments(rawSegments: string[] | undefined): {
  segments: string[] | undefined;
  attachments: DisplayAttachment[] | undefined;
} {
  if (!rawSegments || rawSegments.length === 0) {
    return { segments: undefined, attachments: undefined };
  }

  const harvested: DisplayAttachment[] = [];
  const segments = rawSegments.map((seg) => {
    const { cleanedContent, attachments } =
      parseAttachmentSummariesFromContent(seg);
    if (attachments) {
      harvested.push(...attachments);
    }
    return cleanedContent;
  });

  const attachments =
    harvested.length > 0
      ? harvested.map((att, i) => ({ ...att, id: `rehydrated:${i}` }))
      : undefined;

  return { segments, attachments };
}

/**
 * Map a `ConversationMessage` to a `DisplayMessage`.
 *
 * This is the single `ConversationMessage → DisplayMessage` boundary: every
 * server-side field is interpreted here. Text segments are cleaned of inlined
 * attachment summaries (with fallback stubs reconstructed from those lines),
 * structured attachments are mapped from daemon metadata, the unified
 * `contentBlocks` projection is normalized, and timestamps are coerced to
 * epoch ms. Both the history load (`history.ts`, `messages.ts`) and the
 * periodic server sync (`reconcile.ts`) project through this function, so a
 * server row reaches reconciliation already display-shaped and the merge runs
 * `DisplayMessage → DisplayMessage`.
 */
export function mapRuntimeToDisplayMessage(
  m: ConversationMessage,
): DisplayMessage {
  const { segments: normalizedSegments, attachments: parsedAttachments } =
    cleanTextSegments(
      m.textSegments && m.textSegments.length > 0 ? m.textSegments : undefined,
    );

  const structuredAttachments =
    m.attachments && m.attachments.length > 0
      ? runtimeAttachmentsToDisplay(m.attachments)
      : undefined;

  const normalizedContentOrder = normalizeContentOrder(m.contentOrder);
  const contentBlocks = normalizeContentBlocks(m);

  const toolCalls =
    m.toolCalls && m.toolCalls.length > 0
      ? mapRuntimeToolCalls(m.toolCalls, m.id)
      : undefined;

  const timestamp = parseRuntimeTimestamp(m.timestamp);

  const thinkingSegments =
    m.thinkingSegments && m.thinkingSegments.length > 0
      ? m.thinkingSegments
      : undefined;

  const msg: DisplayMessage = {
    id: m.id,
    role: m.role,
  };
  if (m.mergedMessageIds?.length) msg.mergedMessageIds = m.mergedMessageIds;
  if (m.clientMessageId) msg.clientMessageId = m.clientMessageId;
  if (m.surfaces) msg.surfaces = mapServerSurfaces(m.surfaces);
  if (contentBlocks) msg.contentBlocks = contentBlocks;
  if (normalizedSegments) msg.textSegments = normalizedSegments;
  if (normalizedContentOrder) msg.contentOrder = normalizedContentOrder;
  if (thinkingSegments) msg.thinkingSegments = thinkingSegments;
  if (m.subagentNotification) msg.isSubagentNotification = true;
  if (m.acpNotification) msg.isAcpNotification = true;
  if (m.backgroundEventNotification) msg.isBackgroundEventNotification = true;
  if (m.slackMessage) msg.slackMessage = m.slackMessage;
  if (m.reactions?.length) {
    msg.reactions = m.reactions;
  }
  if (toolCalls) msg.toolCalls = toolCalls;
  if (timestamp != null) msg.timestamp = timestamp;

  const attachments = structuredAttachments ?? parsedAttachments;
  if (attachments) msg.attachments = attachments;

  return msg;
}
