/**
 * Hook that listens for document comment SSE events on the assistant's
 * event stream and triggers a refresh callback when comments change for
 * the specified surface.
 *
 * Wires the SSE event handlers from `document-comment-events.ts` (PR 9)
 * into the document viewer's comment panel (PR 8) via the
 * `refreshComments` callback. The hook subscribes to the global event
 * stream — it does not open its own SSE connection.
 */

import { useCallback, useEffect, useRef } from "react";

import type { AssistantEvent } from "@/domains/chat/api/event-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseDocumentCommentEventsOptions {
  /** The surface ID to watch for comment events. */
  surfaceId: string;
  /** Whether the comment panel is open and listening. */
  enabled: boolean;
  /** Called when a comment event arrives for the watched surface. */
  onCommentsChanged: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns an event handler that can be passed to the SSE stream's `onEvent`
 * callback. When a document comment event arrives for the specified surface,
 * it invokes `onCommentsChanged`.
 *
 * Usage:
 * ```tsx
 * const handleSseEvent = useDocumentCommentEvents({
 *   surfaceId,
 *   enabled: commentsPanelOpen,
 *   onCommentsChanged: () => commentPanelRef.current?.refreshComments(),
 * });
 * ```
 */
export function useDocumentCommentEvents({
  surfaceId,
  enabled,
  onCommentsChanged,
}: UseDocumentCommentEventsOptions): (event: AssistantEvent) => void {
  const callbackRef = useRef(onCommentsChanged);
  useEffect(() => {
    callbackRef.current = onCommentsChanged;
  }, [onCommentsChanged]);

  return useCallback(
    (event: AssistantEvent) => {
      if (!enabled) return;

      switch (event.type) {
        case "document_comment_created":
        case "document_comment_resolved":
        case "document_comment_reopened":
        case "document_comment_deleted": {
          if (event.surfaceId === surfaceId) {
            callbackRef.current();
          }
          break;
        }
        default:
          break;
      }
    },
    [surfaceId, enabled],
  );
}
