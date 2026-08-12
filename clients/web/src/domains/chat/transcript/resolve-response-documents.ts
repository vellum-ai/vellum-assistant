// Assign the documents a response changed to the message that ends it, so a
// response closes with one reopen link per document rather than repeating the
// same link on every message that wrote to it.

import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import {
  resolveChangedDocuments,
  resolveEditedDocuments,
} from "@/domains/chat/transcript/transcript-message-body-shared";

/**
 * Split `items` into responses on the same boundary `partitionLatestTurn`
 * uses: every user message opens a new one. Assistant messages before the
 * first user message form the leading response, and the trailing entry is the
 * response to the newest user message, empty until it produces a message.
 *
 * Non-message items (the thinking slot, pending prompts, ephemeral meta) carry
 * no tool calls and no link slot, so they are skipped rather than split on.
 */
function splitResponses(items: TranscriptItem[]): MessageItem[][] {
  const responses: MessageItem[][] = [[]];

  for (const item of items) {
    if (item.kind !== "message") {
      continue;
    }
    if (item.message.role === "user") {
      responses.push([]);
      continue;
    }
    responses[responses.length - 1]!.push(item);
  }

  return responses;
}

/**
 * The documents `message` opens with an inline `document_preview` card. The
 * card's own `surfaceId` is the surface (`preview-<doc id>`); the document it
 * opens rides in `data.surfaceId`, which is what a document tool call reports
 * in its result.
 */
function previewedDocumentIds(message: DisplayMessage): string[] {
  const surfaceIds: string[] = [];

  for (const block of message.contentBlocks ?? []) {
    if (
      block.type !== "surface" ||
      block.surface.surfaceType !== "document_preview"
    ) {
      continue;
    }
    const surfaceId = block.surface.data?.surfaceId;
    if (typeof surfaceId === "string" && surfaceId !== "") {
      surfaceIds.push(surfaceId);
    }
  }

  return surfaceIds;
}

/**
 * The ids of the documents `response` changed, in first-changed order.
 *
 * A `document_preview` card opens its own document, so a document the response
 * only previews is claimed up front and owes no link beside its card. A
 * document the response also writes to is changed below that card, so it stays
 * unclaimed and still ends the response with a link.
 *
 * The claim set spans the whole response, so repeated edits of one document
 * collapse into a single id, whether they ran in one message or several.
 */
function changedDocumentIds(response: MessageItem[]): string[] {
  const edited = new Set<string>();
  for (const item of response) {
    for (const surfaceId of resolveEditedDocuments(
      item.message.toolCalls ?? [],
    )) {
      edited.add(surfaceId);
    }
  }

  const claimed = new Set<string>();
  for (const item of response) {
    for (const surfaceId of previewedDocumentIds(item.message)) {
      if (!edited.has(surfaceId)) {
        claimed.add(surfaceId);
      }
    }
  }

  const surfaceIds: string[] = [];
  for (const item of response) {
    surfaceIds.push(
      ...resolveChangedDocuments(item.message.toolCalls ?? [], claimed),
    );
  }

  return surfaceIds;
}

/**
 * Whether `item` can carry its response's reopen links. System cards render
 * through `SystemCardRow`, which has no link slot, so a response that ends on
 * one anchors its links on the last ordinary message instead.
 */
function canAnchorLinks(item: MessageItem): boolean {
  return !item.message.isSystemCard;
}

/** Previously returned ids, keyed by the message that anchored them. */
const idsByAnchor = new WeakMap<DisplayMessage, string[]>();

/**
 * Reuse the previous array for an anchor whose ids are unchanged, so the row
 * carrying the links keeps its `memo()` across the re-render every streaming
 * token triggers.
 */
function stableIds(anchor: DisplayMessage, surfaceIds: string[]): string[] {
  const cached = idsByAnchor.get(anchor);
  if (
    cached &&
    cached.length === surfaceIds.length &&
    cached.every((id, i) => id === surfaceIds[i])
  ) {
    return cached;
  }
  idsByAnchor.set(anchor, surfaceIds);
  return surfaceIds;
}

export interface ResolveResponseDocumentsOptions {
  /**
   * Whether a turn is in flight. The trailing response is the one being
   * generated, so it is left out until the turn settles and its closing
   * affordance is honest.
   */
  turnActive?: boolean;
}

/**
 * The documents each completed response changed, keyed by the transcript item
 * key of the message that ends that response.
 *
 * Each id rides on its tool call's persisted `result`, so a response reseeded
 * from `/messages` resolves the same ids as the streamed one.
 *
 * Rows read their own entry, so every row without links keeps a stable
 * `undefined` and every row with them keeps a stable array.
 */
export function resolveResponseDocumentIds(
  items: TranscriptItem[],
  options?: ResolveResponseDocumentsOptions,
): Map<string, string[]> {
  const byItemKey = new Map<string, string[]>();
  const responses = splitResponses(items);
  const inFlightIndex = options?.turnActive ? responses.length - 1 : -1;

  responses.forEach((response, index) => {
    if (index === inFlightIndex) {
      return;
    }
    const anchor = response.findLast(canAnchorLinks);
    if (!anchor) {
      return;
    }
    const surfaceIds = changedDocumentIds(response);
    if (surfaceIds.length === 0) {
      return;
    }
    byItemKey.set(anchor.key, stableIds(anchor.message, surfaceIds));
  });

  return byItemKey;
}
