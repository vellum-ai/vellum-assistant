/**
 * Every attachment a conversation carries, from the daemon's own listing where
 * the assistant serves it and from the loaded transcript rows otherwise.
 *
 * The daemon path reads `GET /v1/attachments?conversationId=` twice, once
 * leaving the camera frames out and once taking only them, so each category
 * reports the conversation's exact total and the frames the transcript cannot
 * see. It is taken only while {@link useSupportsAttachmentList} allows it, and
 * a 404 (a build cut before the route landed) puts that target back on the
 * transcript for the life of the component. Rows keep the response's order,
 * which is newest first, and carry no bytes: a tile fetches those lazily under
 * the shared attachment-content key.
 *
 * The transcript path reads the rows that carry attachments, which is the
 * loaded pages only, so `totalFiles` counts what is loaded rather than what the
 * conversation holds. Subscribing to those rows alone rather than to the whole
 * transcript keeps the always-mounted header trigger still while a turn
 * streams: older rows keep their identity and the streaming assistant row
 * carries nothing, so the selected set stays shallow-equal. Selecting the
 * snapshot's `messages` reference instead would cost less per store write and
 * re-render this hook on every token batch, which is the per-commit traffic
 * `docs/CONVENTIONS.md` keeps out of a streaming conversation.
 * The transcript also cannot see the camera-frame tag: that lives in daemon
 * message metadata which never crosses the message wire, so `sightFrame` is
 * always false and `totalFrames` always 0 on that source.
 */

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type ChatSessionStore,
  useChatSessionStore,
} from "@/domains/chat/chat-session-store";
import {
  type DaemonSourceState,
  daemonSourceState,
  worstSourceState,
} from "@/domains/chat/hooks/daemon-source-state";
import { selectTranscriptMessages } from "@/domains/chat/transcript/select-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  attachmentsGetInfiniteOptions,
  attachmentsGetInfiniteQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AttachmentsGetResponse } from "@/generated/daemon/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useSupportsAttachmentList } from "@/lib/backwards-compat/use-supports-attachment-list";
import type {
  ConversationAttachmentSummary,
  DisplayAttachment,
} from "@/types/attachment-types";
import { ApiError } from "@/utils/api-errors";
import { deriveDisplayUrls } from "@/utils/attachment-urls";
import { shouldRetryDaemonOrNetworkError } from "@/utils/daemon-errors";

/** Rows per list request, and what one Load more adds. The route's default. */
export const ATTACHMENT_PAGE_SIZE = 200;

/** Which half of a conversation's attachments one list request answers with. */
export type SightFrameFilter = "exclude" | "only";

/**
 * The request one list read is made with, so a caller seeding the cache and the
 * hook reading it cannot land on different keys.
 */
export function conversationAttachmentListArgs(
  assistantId: string,
  conversationId: string,
  sightFrames: SightFrameFilter,
) {
  return {
    path: { assistant_id: assistantId },
    query: { conversationId, sightFrames, limit: ATTACHMENT_PAGE_SIZE },
  };
}

export interface ConversationAttachmentEntry {
  /**
   * Unique within the conversation. The attachment id, except for a legacy row
   * without structured metadata, whose `rehydrated:N` ids restart per row and
   * can repeat inside one row once adjacent assistant rows are folded, so
   * those are keyed by row and position instead.
   */
  key: string;
  attachment: DisplayAttachment;
  /** The carrying row's timestamp, epoch ms; null when the row carries none. */
  capturedAt: number | null;
  /** Captured by the live-vision camera gate. Always false on the transcript path. */
  sightFrame: boolean;
}

export interface ConversationAttachments {
  entries: ConversationAttachmentEntry[];
  /** Exact on the daemon path; the entry counts on the transcript path. */
  totalFiles: number;
  totalFrames: number;
  /**
   * How far the active path has got. The daemon path reports the two list
   * reads; the transcript path is ready once the target's own transcript has
   * stopped loading (its chat session owns it, and either a snapshot is loaded
   * or the history fetch is over) and never failed, since a history load that
   * failed settles rather than staying unready for good.
   */
  sourceState: DaemonSourceState;
  hasMoreFiles: boolean;
  hasMoreFrames: boolean;
  loadMoreFiles: () => void;
  loadMoreFrames: () => void;
  source: "daemon" | "transcript";
}

/** Stable empty result, so a conversation with nothing stays referentially stable. */
const NO_ENTRIES: ConversationAttachmentEntry[] = [];

const NOOP = () => {};

function entryKey(
  messageId: string,
  attachmentId: string,
  position: number,
): string {
  return attachmentId.startsWith("rehydrated:")
    ? `${messageId}:${position}`
    : attachmentId;
}

function carriesAttachments(message: DisplayMessage): boolean {
  return (message.attachments?.length ?? 0) > 0;
}

/**
 * The rows carrying attachments, composed the way `useTranscriptMessages`
 * composes the whole transcript: the snapshot overlaid with the optimistic
 * sends by message identity, in snapshot order. The dismissed-surface filter
 * that read applies is left out because it only ever strips a row's surfaces,
 * never its attachments.
 */
function selectAttachmentRows(state: ChatSessionStore): DisplayMessage[] {
  return selectTranscriptMessages(
    (state.snapshot?.messages ?? []).filter(carriesAttachments),
    state.optimisticSends.filter(carriesAttachments),
  );
}

/**
 * One listed row as the panel's entry. Daemon ids are unique across the
 * conversation, so the row-scoped key the transcript path mints is not needed
 * here. `previewUrl` stays null so the tile fetches the bytes lazily.
 */
function toDaemonEntry(
  summary: ConversationAttachmentSummary,
): ConversationAttachmentEntry {
  return {
    key: summary.id,
    attachment: {
      id: summary.id,
      filename: summary.filename,
      mimeType: summary.mimeType,
      sizeBytes: summary.sizeBytes,
      ...deriveDisplayUrls(
        summary.mimeType,
        undefined,
        summary.thumbnailData,
        true,
      ),
    },
    capturedAt: summary.createdAt,
    sightFrame: summary.sightFrame,
  };
}

/** The offset of the row after everything loaded, while the daemon holds more. */
function nextAttachmentOffset(
  lastPage: AttachmentsGetResponse,
  pages: AttachmentsGetResponse[],
): number | undefined {
  if (!lastPage.hasMore) {
    return undefined;
  }
  return pages.reduce((loaded, page) => loaded + page.attachments.length, 0);
}

/** A route the assistant does not serve, which is what the gate could not tell. */
function isRouteMissing(error: Error | null): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function useConversationAttachments(target: {
  assistantId: string;
  conversationId: string;
  /** Bumped externally to re-read the daemon's lists. */
  refreshKey?: number;
}): ConversationAttachments {
  const { assistantId, conversationId, refreshKey } = target;
  const queryClient = useQueryClient();
  const supportsList = useSupportsAttachmentList();
  // The same gate the panel's other daemon reads wait on: a request sent
  // before the org header can be produced fails for a reason the conversation
  // has nothing to do with.
  const isOrgReady = useIsOrgReady();

  // A 404 is the gate's blind spot: a build carrying the gated version but cut
  // before the route landed. Remembered per target so the fallback holds for
  // the life of this component rather than being re-learned every render.
  const targetKey = `${assistantId}/${conversationId}`;
  const [routeMissingFor, setRouteMissingFor] = useState<string | null>(null);

  const filesArgs = useMemo(
    () =>
      conversationAttachmentListArgs(assistantId, conversationId, "exclude"),
    [assistantId, conversationId],
  );
  const framesArgs = useMemo(
    () => conversationAttachmentListArgs(assistantId, conversationId, "only"),
    [assistantId, conversationId],
  );

  const listsRequested =
    supportsList && isOrgReady && routeMissingFor !== targetKey;
  const filesQuery = useInfiniteQuery({
    ...attachmentsGetInfiniteOptions(filesArgs),
    initialPageParam: 0,
    getNextPageParam: nextAttachmentOffset,
    enabled: listsRequested,
    retry: shouldRetryDaemonOrNetworkError,
  });
  const framesQuery = useInfiniteQuery({
    ...attachmentsGetInfiniteOptions(framesArgs),
    initialPageParam: 0,
    getNextPageParam: nextAttachmentOffset,
    enabled: listsRequested,
    retry: shouldRetryDaemonOrNetworkError,
  });

  const routeMissing =
    isRouteMissing(filesQuery.error) || isRouteMissing(framesQuery.error);
  useEffect(() => {
    if (routeMissing) {
      setRouteMissingFor(targetKey);
    }
  }, [routeMissing, targetKey]);
  const listsActive =
    supportsList && !routeMissing && routeMissingFor !== targetKey;
  const listsEnabled = listsActive && isOrgReady;

  const fetchNextFiles = filesQuery.fetchNextPage;
  const fetchNextFrames = framesQuery.fetchNextPage;
  const loadMoreFiles = useCallback(() => {
    void fetchNextFiles();
  }, [fetchNextFiles]);
  const loadMoreFrames = useCallback(() => {
    void fetchNextFrames();
  }, [fetchNextFrames]);

  const filesPages = filesQuery.data?.pages;
  const framesPages = framesQuery.data?.pages;
  const daemonLists = useMemo(() => {
    if (filesPages === undefined || framesPages === undefined) {
      return null;
    }
    const filesTail = filesPages[filesPages.length - 1]!;
    const framesTail = framesPages[framesPages.length - 1]!;
    return {
      entries: [
        ...filesPages.flatMap((page) => page.attachments.map(toDaemonEntry)),
        ...framesPages.flatMap((page) => page.attachments.map(toDaemonEntry)),
      ],
      totalFiles: filesTail.total,
      totalFrames: framesTail.total,
      hasMoreFiles: filesTail.hasMore,
      hasMoreFrames: framesTail.hasMore,
    };
  }, [filesPages, framesPages]);
  const listsState = worstSourceState(
    daemonSourceState(filesQuery),
    daemonSourceState(framesQuery),
  );

  // The chat-session store names the conversation its snapshot was loaded for.
  // The navigation selection flips a render before that snapshot is cleared, so
  // gating on it would list the outgoing conversation's files under the new id.
  const ownerAssistantId = useChatSessionStore.use.previousAssistantId();
  const ownerConversationId = useChatSessionStore.use.previousConversationId();
  const ownsTranscript =
    ownerAssistantId === assistantId && ownerConversationId === conversationId;

  const hasSnapshot = useChatSessionStore((state) => state.snapshot !== null);
  // The store's own loading flag, never its `error` field: a failed send sets
  // that too, and a send has nothing to say about the transcript.
  const isLoadingHistory = useChatSessionStore.use.isLoadingHistory();

  const messages = useChatSessionStore(useShallow(selectAttachmentRows));

  const entries = useMemo(() => {
    if (!ownsTranscript) {
      return NO_ENTRIES;
    }
    const collected: ConversationAttachmentEntry[] = [];
    const seen = new Set<string>();
    // Newest first, and an optimistic row plus its confirmed echo carry the
    // same attachment ids, so the first sighting wins.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      // A channel-deleted row keeps its content but renders as a tombstone,
      // so its files are not on show either.
      if (message.deletedAt) {
        continue;
      }
      const attachments = message.attachments ?? [];
      // Send order within a row: `mergedMessageIds` is also stamped for
      // stream-id reconciliation, so it cannot mark a concatenated row.
      for (let position = 0; position < attachments.length; position += 1) {
        const attachment = attachments[position]!;
        const key = entryKey(message.id, attachment.id, position);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        collected.push({
          key,
          attachment,
          capturedAt: message.timestamp ?? null,
          sightFrame: false,
        });
      }
    }
    return collected.length === 0 ? NO_ENTRIES : collected;
  }, [messages, ownsTranscript]);

  const invalidateLists = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: attachmentsGetInfiniteQueryKey(filesArgs),
    });
    void queryClient.invalidateQueries({
      queryKey: attachmentsGetInfiniteQueryKey(framesArgs),
    });
  }, [queryClient, filesArgs, framesArgs]);

  // A frame kept while the panel is open reaches the transcript over SSE, so
  // that set changing is the signal the lists are behind.
  const transcriptIds = useMemo(
    () => entries.map((entry) => entry.attachment.id).join(","),
    [entries],
  );
  const listedTranscriptIds = useRef(transcriptIds);
  useEffect(() => {
    if (listedTranscriptIds.current === transcriptIds) {
      return;
    }
    listedTranscriptIds.current = transcriptIds;
    if (listsEnabled) {
      invalidateLists();
    }
  }, [transcriptIds, listsEnabled, invalidateLists]);

  useEffect(() => {
    if (refreshKey === undefined || !listsEnabled) {
      return;
    }
    invalidateLists();
  }, [refreshKey, listsEnabled, invalidateLists]);

  const transcriptState: DaemonSourceState =
    ownsTranscript && (hasSnapshot || !isLoadingHistory)
      ? "ready"
      : "unresolved";

  return useMemo(() => {
    if (listsActive && daemonLists) {
      return {
        entries: daemonLists.entries,
        totalFiles: daemonLists.totalFiles,
        totalFrames: daemonLists.totalFrames,
        sourceState: listsState,
        hasMoreFiles: daemonLists.hasMoreFiles,
        hasMoreFrames: daemonLists.hasMoreFrames,
        loadMoreFiles,
        loadMoreFrames,
        source: "daemon" as const,
      };
    }
    return {
      entries,
      totalFiles: entries.length,
      // The transcript path cannot produce a frame: it never sees the tag.
      totalFrames: 0,
      // A list still on its way speaks for the panel even though the entries
      // below it are the transcript's, so an open panel is never empty and
      // never reads settled before the daemon has answered.
      sourceState: listsActive ? listsState : transcriptState,
      hasMoreFiles: false,
      hasMoreFrames: false,
      loadMoreFiles: NOOP,
      loadMoreFrames: NOOP,
      source: "transcript" as const,
    };
  }, [
    daemonLists,
    entries,
    listsActive,
    listsState,
    loadMoreFiles,
    loadMoreFrames,
    transcriptState,
  ]);
}
