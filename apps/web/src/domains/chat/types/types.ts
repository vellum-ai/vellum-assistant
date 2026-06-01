/**
 * Shared types for the chat/surface system.
 */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayAttachment } from "@/types/attachment-types";
import type { SlackMessageLink } from "@/utils/slack-message-link";

export type { DisplayAttachment } from "@/types/attachment-types";

export type { SlackMessageLink } from "@/utils/slack-message-link";
export { parseSlackMessageLink, getSlackLinkUrl } from "@/utils/slack-message-link";

export interface SlackMessageSender {
  id?: string;
  externalUserId?: string;
  name?: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
  isBot?: boolean;
}

export interface SlackRuntimeMessage {
  channelId: string;
  channelName?: string;
  channelTs: string;
  threadTs?: string;
  sender?: SlackMessageSender;
  messageLink?: SlackMessageLink;
  threadLink?: SlackMessageLink;
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
   * the server snapshot directly; optimistic user rows get a content
   * match + id swap, optimistic assistant rows are preserved as-is until
   * a subsequent SSE event or history fetch resolves them.
   */
  isOptimistic?: boolean;
  /**
   * Server message ids folded into this canonical display row. Reconcile treats
   * these as aliases so a live SSE row can merge into its collapsed history row.
   */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  surfaces?: Surface[];
  textSegments?: Array<{ type: string; content: string; [key: string]: unknown }>;
  contentOrder?: Array<{ type: string; id: string }>;
  metadata?: Record<string, unknown>;
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
  /** True for daemon-injected subagent lifecycle notifications that should
   *  not render as user bubbles. Matches macOS `isSubagentNotification`. */
  isSubagentNotification?: boolean;
}

export interface Surface {
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
  actions?: Array<{ id: string; label: string; style?: string; data?: Record<string, unknown> }>;
  display?: "inline" | "panel";
  messageId?: string;
  /** True when the surface's messageId doesn't match any existing message
   *  at the time of ui_surface_show. The streaming message's id may not
   *  be known yet — this flag lets TranscriptMessageBody attach the
   *  surface to the current streaming message as a fallback. Cleared
   *  once the surface is bound to a resolved message id. */
  orphaned?: boolean;
  /** Set after the user acts on the surface — matches macOS
   *  `SurfaceCompletionState`. The surface stays in the message but
   *  renders as a non-interactive chip instead of the active widget. */
  completed?: boolean;
  completionSummary?: string;
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
const INHERENTLY_INTERACTIVE_SURFACE_TYPES = [
  "form",
  "confirmation",
  "file_upload",
  "task_preferences",
];

/**
 * Whether a surface requires user interaction to "complete".
 *
 * A surface is interactive when it either carries explicit action buttons
 * or is an inherently interactive type (form, confirmation, file_upload).
 * Display-only surfaces — tables, cards, lists, and dynamic pages without
 * actions — are non-interactive and should never block the composer.
 */
export function isSurfaceInteractive(surface: Surface): boolean {
  if (surface.completed) return false;
  const hasActions =
    Array.isArray(surface.actions) && surface.actions.length > 0;
  return hasActions || INHERENTLY_INTERACTIVE_SURFACE_TYPES.includes(surface.surfaceType);
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
