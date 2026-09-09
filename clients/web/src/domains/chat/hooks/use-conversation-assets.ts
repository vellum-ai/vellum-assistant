/**
 * A conversation's assets in the three categories the chat-info panel lists:
 * apps, files (daemon documents plus the attachments that are not camera
 * frames), and camera frames. Frames stay empty while attachments come from
 * the transcript, which cannot see the camera-frame tag.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import {
  appsGetOptions,
  appsGetQueryKey,
  documentsGetOptions,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  type ConversationAttachmentEntry,
  useConversationAttachments,
} from "@/domains/chat/hooks/use-conversation-attachments";
import type { AppSummary } from "@/types/app-types";
import type { DisplayAttachment } from "@/types/attachment-types";
import type { DocumentSummary } from "@/types/document-types";
import { isExpectedDaemonTransientError } from "@/utils/daemon-errors";

export type ConversationFileAsset =
  | { kind: "document"; id: string; title: string; doc: DocumentSummary }
  | {
      kind: "attachment";
      id: string;
      title: string;
      attachment: DisplayAttachment;
    }
  | {
      kind: "frame";
      id: string;
      title: string;
      attachment: DisplayAttachment;
      capturedAt: number | null;
    };

/**
 * How far the panel's three sources have got: the two daemon queries and the
 * conversation's own transcript, which is loaded rather than fetched and is
 * unsettled until the chat session's history load for this conversation ends.
 */
export type ConversationAssetsStatus = "pending" | "error" | "ready";

interface ConversationAssets {
  apps: AppSummary[];
  /** Documents, newest first, then the attachments that are not frames. */
  files: ConversationFileAsset[];
  frames: ConversationFileAsset[];
  counts: { apps: number; files: number; frames: number };
  /** Sum of `counts`: what the header trigger shows, and hides on when zero. */
  count: number;
  /**
   * Whether the categories can be believed yet. An empty category means
   * "nothing here" only once this reads `"ready"`.
   */
  status: ConversationAssetsStatus;
  hasMoreFiles: boolean;
  hasMoreFrames: boolean;
  loadMoreFiles: () => void;
  loadMoreFrames: () => void;
}

interface ConversationAssetsTarget {
  assistantId: string;
  conversationId: string;
  /** Bumped externally to trigger a refetch (e.g. on ui_surface_show). Only one mounted caller should pass it. */
  refreshKey?: number;
}

/** Stable empties, so an unresolved query does not thrash the memos below. */
const NO_APPS: AppSummary[] = [];
const NO_DOCUMENTS: DocumentSummary[] = [];

/**
 * Ids are prefixed per kind so a document, an attachment, and a frame that
 * happen to share an underlying id can never collide as React keys.
 */
export function toConversationFileAssets(
  docs: DocumentSummary[],
  entries: ConversationAttachmentEntry[],
): { files: ConversationFileAsset[]; frames: ConversationFileAsset[] } {
  const files: ConversationFileAsset[] = [...docs]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((doc) => ({
      kind: "document" as const,
      id: `doc-${doc.surfaceId}`,
      title: doc.title,
      doc,
    }));
  const frames: ConversationFileAsset[] = [];

  for (const entry of entries) {
    if (entry.sightFrame) {
      frames.push({
        kind: "frame",
        id: `frame-${entry.key}`,
        title: entry.attachment.filename,
        attachment: entry.attachment,
        capturedAt: entry.capturedAt,
      });
    } else {
      files.push({
        kind: "attachment",
        id: `att-${entry.key}`,
        title: entry.attachment.filename,
        attachment: entry.attachment,
      });
    }
  }

  return { files, frames };
}

export function useConversationAssets({
  assistantId,
  conversationId,
  refreshKey,
}: ConversationAssetsTarget): ConversationAssets {
  const queryClient = useQueryClient();
  const appsQuery = useQuery({
    ...appsGetOptions({
      path: { assistant_id: assistantId },
      query: { conversationId },
    }),
    select: (data) => data.apps,
  });
  const documentsQuery = useQuery({
    ...documentsGetOptions({
      path: { assistant_id: assistantId },
      query: { conversationId },
    }),
    select: (data) => data.documents,
  });

  useEffect(() => {
    if (refreshKey === undefined) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: appsGetQueryKey({
        path: { assistant_id: assistantId },
        query: { conversationId },
      }),
    });
    void queryClient.invalidateQueries({
      queryKey: documentsGetQueryKey({
        path: { assistant_id: assistantId },
        query: { conversationId },
      }),
    });
  }, [refreshKey, queryClient, assistantId, conversationId]);

  const attachments = useConversationAttachments({
    assistantId,
    conversationId,
  });

  const apps = appsQuery.data ?? NO_APPS;
  const docs = documentsQuery.data ?? NO_DOCUMENTS;

  // A failed background refetch keeps the last data, so a source is failed or
  // unresolved only while it has nothing to show. The transcript counts as a
  // source too: without it a conversation whose only assets are attachments
  // would read ready and empty until the snapshot lands.
  const appsUnresolved = appsQuery.data === undefined;
  const documentsUnresolved = documentsQuery.data === undefined;
  // The daemon's startup and auth races answer nothing yet rather than
  // refusing: a 503 through `vellum wake` would otherwise leave every
  // conversation header reporting a failure for the length of a restart.
  const failed =
    (appsQuery.isError &&
      appsUnresolved &&
      !isExpectedDaemonTransientError(appsQuery.error)) ||
    (documentsQuery.isError &&
      documentsUnresolved &&
      !isExpectedDaemonTransientError(documentsQuery.error));
  let status: ConversationAssetsStatus = "ready";
  if (failed) {
    status = "error";
  } else if (
    appsUnresolved ||
    documentsUnresolved ||
    !attachments.transcriptSettled
  ) {
    status = "pending";
  }

  const sortedApps = useMemo(
    () => [...apps].sort((a, b) => b.updatedAt - a.updatedAt),
    [apps],
  );

  const { files, frames } = useMemo(
    () => toConversationFileAssets(docs, attachments.entries),
    [docs, attachments.entries],
  );

  return useMemo(() => {
    const counts = {
      apps: sortedApps.length,
      files: docs.length + attachments.totalFiles,
      frames: attachments.totalFrames,
    };
    return {
      apps: sortedApps,
      files,
      frames,
      counts,
      count: counts.apps + counts.files + counts.frames,
      status,
      hasMoreFiles: attachments.hasMoreFiles,
      hasMoreFrames: attachments.hasMoreFrames,
      loadMoreFiles: attachments.loadMoreFiles,
      loadMoreFrames: attachments.loadMoreFrames,
    };
  }, [sortedApps, files, frames, docs.length, attachments, status]);
}
