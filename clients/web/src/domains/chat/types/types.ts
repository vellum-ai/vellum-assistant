/**
 * Shared types for the chat/surface system.
 */

import type {
  ConversationContentBlock,
  ConversationMessage,
  ConversationMessageSurface,
} from "@vellumai/assistant-api";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { isToolCallCompleted } from "@/domains/chat/utils/tool-call-status";
import type { DisplayAttachment } from "@/types/attachment-types";
import type { ExternalSourceLink } from "@/utils/external-source-link";

export type { DisplayAttachment } from "@/types/attachment-types";

export type { ExternalSourceLink } from "@/utils/external-source-link";
export { getExternalLinkUrl } from "@/utils/external-source-link";

export interface SlackMessageSender {
  id?: string;
  externalUserId?: string;
  name?: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
  isBot?: boolean;
}

export interface SlackReaction {
  emoji: string;
  op: "added" | "removed";
  actorDisplayName?: string;
  targetChannelTs: string;
}

export interface SlackRuntimeMessage {
  channelId: string;
  channelName?: string;
  channelTs: string;
  threadTs?: string;
  sender?: SlackMessageSender;
  messageLink?: ExternalSourceLink;
  threadLink?: ExternalSourceLink;
  eventKind?: "message" | "reaction";
  reaction?: SlackReaction;
}

/**
 * Result of a local meta slash command (`/clean`, `/status`, `/commands`,
 * `/models`). Rendered as an ephemeral card at the transcript tail — never
 * persisted, cleared on the next real send, conversation switch, or reload.
 */
export interface EphemeralMetaResult {
  /** Stable key for the transcript row. */
  id: string;
  kind: "clean" | "info";
  /** User-facing text to render (clean stats card or info listing). */
  text: string;
}

export interface DisplayMessage {
  /**
   * Row identity. Server-assigned message id for confirmed rows; a
   * client-generated identifier for rows that haven't been confirmed by
   * the server yet (optimistic user sends, assistant rows born from a
   * tool/surface SSE event that didn't carry `messageId`). Used as the
   * row key in the virtualized transcript and as the match key in
   * reconcile. For assistant turns the server merges across multiple DB
   * rows, this is the display anchor — server-side actions (fork,
   * inspect) accept this id and resolve the merged cluster internally.
   */
  id: string;
  /**
   * True when `id` is a client-generated placeholder rather than a
   * server-assigned id. Set on optimistic user sends and on assistant
   * rows born from SSE events that didn't carry `messageId`. Reconcile
   * uses this as the signal that the row's id can't be matched against
   * the server snapshot directly; optimistic user rows get a derived-text
   * match + id swap, optimistic assistant rows are preserved as-is until
   * a subsequent SSE event or history fetch resolves them.
   */
  isOptimistic?: boolean;
  /**
   * Server message ids folded into this canonical display row. Reconcile treats
   * these as aliases so a live SSE row can merge into its collapsed history row.
   */
  mergedMessageIds?: string[];
  /**
   * Client-generated correlation nonce, carried from the wire
   * `ConversationMessage["clientMessageId"]`. The originating client mints it
   * at send time, sends it on the POST body, and the daemon echoes it back on
   * the `user_message_echo` event and the messages snapshot. Reconcile and the
   * echo handler match an optimistic user row to its confirmed server row on
   * this identity rather than on text, so duplicate or normalized content
   * cannot mis-correlate. Absent on rows that never originated a client send
   * (passive viewers, assistant turns, daemons that predate the field).
   */
  clientMessageId?: string;
  /**
   * Message role, carried straight through from the canonical wire contract
   * (`ConversationMessage["role"]`). The transcript renders `"user"` rows as
   * the sender's bubble and treats every other role as an assistant turn, so
   * no narrowing of the wire value is required.
   */
  role: ConversationMessage["role"];
  surfaces?: Surface[];
  /**
   * Unified, single-ordered list of content blocks (text / thinking /
   * tool_use / surface / attachment), carried straight through from the wire
   * `ConversationMessage["contentBlocks"]`. Populated at the ingest boundary
   * by `normalizeContentBlocks`, which returns the daemon's projection
   * verbatim when present and reconstructs it from the positional arrays for
   * daemons that predate it. This is the canonical ordering the transcript
   * renders from; the positional arrays below (`contentOrder` /
   * `textSegments` / `thinkingSegments`) are the legacy transport this
   * supersedes and are retired once every renderer reads `contentBlocks`.
   */
  contentBlocks?: ConversationContentBlock[];
  /** Ordered text bodies, matching the wire `textSegments: string[]`. Each
   *  entry is referenced positionally by a `text:N` entry in `contentOrder`. */
  textSegments?: string[];
  contentOrder?: Array<{ type: string; id: string }>;
  slackMessage?: SlackRuntimeMessage;
  toolCalls?: ChatMessageToolCall[];
  /** Attachments rendered inside the message bubble. For user messages these
   *  are populated client-side from the upload flow; for assistant messages
   *  they arrive via the `message_complete` SSE event. */
  attachments?: DisplayAttachment[];
  /** Timestamp in milliseconds since epoch. Sourced from the server when
   *  available, otherwise set client-side when the message is first created. */
  timestamp?: number;
  /** Set on user messages that are waiting in the server queue. */
  queueStatus?: "queued" | "processing";
  /** 1-based position in the queue, updated by `message_queued` SSE events. */
  queuePosition?: number;
  /** Reasoning content produced by thinking-capable models. Each entry
   *  corresponds to a `thinking:N` entry in `contentOrder`. Populated from
   *  the server's `thinkingSegments` field on history loads, and
   *  accumulated live from `assistant_thinking_delta` SSE events. */
  thinkingSegments?: string[];
  /** True for daemon-injected subagent lifecycle notifications that should
   *  not render as user bubbles. Matches macOS `isSubagentNotification`. */
  isSubagentNotification?: boolean;
  /** True for daemon-injected ACP-run lifecycle notifications; suppressed from
   *  the transcript like {@link isSubagentNotification}. */
  isAcpNotification?: boolean;
  /** True for any wake trigger row (`<background_event source="...">`, e.g.
   *  defer/schedule/webhook/background-tool); suppressed from the transcript
   *  like {@link isSubagentNotification} — the wake card shows it instead. */
  isBackgroundEventNotification?: boolean;
  /** True for daemon-authored status cards (the /compact, /clean, and
   *  summarize-up-to results). Rendered as a standalone system notice —
   *  no avatar, no persona bubble — never as assistant speech. */
  isSystemCard?: boolean;
}

/**
 * A UI surface (widget) rendered in the transcript. Extends the canonical wire
 * `ConversationMessageSurface` (carrying `surfaceId`/`surfaceType`/`data`/
 * `actions`/`completed`/`completionSummary`/`toolCallId`) with the client-only
 * binding state the wire omits: a narrowed placement and the live attach/orphan
 * tracking used while a streaming row's id is still settling.
 */
export interface Surface extends ConversationMessageSurface {
  /** Narrowed placement; the wire ships `display` as a free string. */
  display?: "inline" | "panel";
  /** Resolved id of the message the surface is bound to. */
  messageId?: string;
  /** True when the surface's messageId doesn't match any existing message
   *  at the time of ui_surface_show. The streaming message's id may not
   *  be known yet — this flag lets TranscriptMessageBody attach the
   *  surface to the current streaming message as a fallback. Cleared
   *  once the surface is bound to a resolved message id. */
  orphaned?: boolean;
}

/**
 * Surface types that are inherently interactive — they always require user
 * input regardless of whether explicit actions are attached.
 *
 * Note: `dynamic_page` is intentionally excluded. Dynamic pages are
 * persistent app views (e.g. opened via `app_open`) that should never block
 * the composer. They only block when they carry explicit action buttons,
 * which is handled by the `hasActions` check below.
 */
export const INHERENTLY_INTERACTIVE_SURFACE_TYPES = [
  "choice",
  "oauth_connect",
  "form",
  "confirmation",
  "file_upload",
  "task_preferences",
];

/**
 * Whether a surface requires user interaction to "complete".
 *
 * A surface is interactive when it either carries explicit action buttons
 * or is an inherently interactive type (choice, oauth_connect, form,
 * confirmation, file_upload, task_preferences). Display-only surfaces — copy
 * blocks, tables, cards, lists, work results, and dynamic pages without actions
 * — are non-interactive and should never block the composer.
 */
export function isSurfaceInteractive(surface: Surface): boolean {
  if (surface.completed) return false;
  const hasActions =
    Array.isArray(surface.actions) && surface.actions.length > 0;
  return (
    hasActions ||
    INHERENTLY_INTERACTIVE_SURFACE_TYPES.includes(surface.surfaceType)
  );
}

/**
 * Tool names that produce or re-render a surface. Used to locate a surface's
 * likely originating tool call when the surface itself doesn't carry an
 * explicit `toolCallId`.
 */
const SURFACE_PRODUCING_TOOL_NAMES = new Set([
  "ui_show",
  "ui_update",
  "app_open",
  "app_create",
  "app_update",
  "app_refresh",
]);

/**
 * Whether the tool call that produced a surface has finished.
 *
 * Display-only app previews (`dynamic_page`) gate on whether their
 * originating tool call has returned its result — once the result arrives the
 * app HTML is finalized and the preview can load. This is per-surface and
 * independent of whole-turn streaming state, so an app whose tool finishes
 * early unlocks without waiting for the rest of the reply.
 *
 * When the surface carries its originating tool call's id (`toolCallId`),
 * completeness is read directly from that tool call's status. Otherwise it
 * falls back to the latest surface-producing tool call in the same message —
 * covering surfaces that arrive without an explicit link (e.g. from a daemon
 * that predates the field).
 *
 * Surfaces with no resolvable tool call (loaded from history, or pushed
 * outside any surface-producing tool call) are treated as complete — matching
 * how finalized messages have always rendered.
 */
export function isSurfaceToolCallComplete(
  surface: Surface,
  toolCalls: ChatMessageToolCall[] | undefined,
): boolean {
  if (surface.toolCallId) {
    const linked = toolCalls?.find((tc) => tc.id === surface.toolCallId);
    if (linked) {
      return isToolCallCompleted(linked);
    }
    return true;
  }
  let latestSurfaceToolCall: ChatMessageToolCall | undefined;
  for (const toolCall of toolCalls ?? []) {
    if (SURFACE_PRODUCING_TOOL_NAMES.has(toolCall.name)) {
      latestSurfaceToolCall = toolCall;
    }
  }
  if (!latestSurfaceToolCall) {
    return true;
  }
  return isToolCallCompleted(latestSurfaceToolCall);
}

/**
 * Determine the display mode for a surface.
 *
 * Web has no floating panel windows (unlike macOS SurfaceManager), so
 * all surfaces render inline in the chat. The only exception is
 * `dynamic_page` without a preview — those render in the panel area
 * as an embedded iframe below the transcript.
 */
export function classifySurfaceDisplay(surface: Surface): Surface["display"] {
  if (surface.surfaceType === "dynamic_page") {
    const data = surface.data as Record<string, unknown>;
    const hasPreview = data?.appId || data?.preview;
    return hasPreview ? "inline" : surface.display;
  }
  return "inline";
}
