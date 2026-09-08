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
  conversationAttachmentKey,
} from "@/domains/chat/hooks/use-conversation-attachments";
import type { AppSummary } from "@/types/app-types";
import type { DisplayAttachment } from "@/types/attachment-types";
import type { DocumentSummary } from "@/types/document-types";

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

export interface ConversationAssets {
  apps: AppSummary[];
  /** Documents, newest first, then the attachments that are not frames. */
  files: ConversationFileAsset[];
  frames: ConversationFileAsset[];
  counts: { apps: number; files: number; frames: number };
  /** Sum of `counts`: what the header pill shows, and hides on when zero. */
  count: number;
  hasMoreFiles: boolean;
  hasMoreFrames: boolean;
  loadMoreFiles: () => void;
  loadMoreFrames: () => void;
}

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
        id: `frame-${conversationAttachmentKey(entry.messageId, entry.attachment.id)}`,
        title: entry.attachment.filename,
        attachment: entry.attachment,
        capturedAt: entry.capturedAt,
      });
    } else {
      files.push({
        kind: "attachment",
        id: `att-${conversationAttachmentKey(entry.messageId, entry.attachment.id)}`,
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
}: {
  assistantId: string;
  conversationId: string;
  /** Bumped externally to trigger a refetch (e.g. on ui_surface_show). Only one mounted caller should pass it. */
  refreshKey?: number;
}): ConversationAssets {
  const queryClient = useQueryClient();
  const appsQueryOpts = appsGetOptions({
    path: { assistant_id: assistantId },
    query: { conversationId },
  });
  const docsQueryOpts = documentsGetOptions({
    path: { assistant_id: assistantId },
    query: { conversationId },
  });

  const { data: apps = [] } = useQuery({
    ...appsQueryOpts,
    select: (data) => data.apps,
  });
  const { data: docs = [] } = useQuery({
    ...docsQueryOpts,
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
      hasMoreFiles: attachments.hasMoreFiles,
      hasMoreFrames: attachments.hasMoreFrames,
      loadMoreFiles: attachments.loadMoreFiles,
      loadMoreFrames: attachments.loadMoreFrames,
    };
  }, [sortedApps, files, frames, docs.length, attachments]);
}
