/**
 * A conversation's assets in the three categories the chat-info panel lists:
 * apps, files (daemon documents plus the attachments that are not camera
 * frames), and camera frames. Frames stay empty while attachments come from
 * the transcript, which cannot see the camera-frame tag.
 *
 * `useConversationAssetCounts` is the totals alone, over the same sources, for
 * the header trigger that shows a number rather than the tiles.
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
  type ConversationAttachments,
  useConversationAttachments,
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

export interface ConversationAssetCounts {
  counts: { apps: number; files: number; frames: number };
  /** Sum of `counts`: what the header pill shows, and hides on when zero. */
  count: number;
}

export interface ConversationAssets extends ConversationAssetCounts {
  apps: AppSummary[];
  /** Documents, newest first, then the attachments that are not frames. */
  files: ConversationFileAsset[];
  frames: ConversationFileAsset[];
  hasMoreFiles: boolean;
  hasMoreFrames: boolean;
  loadMoreFiles: () => void;
  loadMoreFrames: () => void;
}

export interface ConversationAssetsTarget {
  assistantId: string;
  conversationId: string;
  /** Bumped externally to trigger a refetch (e.g. on ui_surface_show). Only one mounted caller should pass it. */
  refreshKey?: number;
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

/**
 * The two queries and the transcript attachments every asset reader shares,
 * plus the refresh invalidation, so the queries and their keys live once.
 */
function useConversationAssetSources({
  assistantId,
  conversationId,
  refreshKey,
}: ConversationAssetsTarget) {
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

  return { apps, docs, attachments };
}

function toAssetCounts(
  appCount: number,
  docCount: number,
  attachments: ConversationAttachments,
): ConversationAssetCounts {
  const counts = {
    apps: appCount,
    files: docCount + attachments.totalFiles,
    frames: attachments.totalFrames,
  };
  return { counts, count: counts.apps + counts.files + counts.frames };
}

/**
 * How many assets a conversation holds, per category and in total, without
 * building the tile model. The header trigger reads only the number, so it
 * pays for the shared queries and nothing more.
 */
export function useConversationAssetCounts(
  target: ConversationAssetsTarget,
): ConversationAssetCounts {
  const { apps, docs, attachments } = useConversationAssetSources(target);

  return useMemo(
    () => toAssetCounts(apps.length, docs.length, attachments),
    [apps.length, docs.length, attachments],
  );
}

export function useConversationAssets(
  target: ConversationAssetsTarget,
): ConversationAssets {
  const { apps, docs, attachments } = useConversationAssetSources(target);

  const sortedApps = useMemo(
    () => [...apps].sort((a, b) => b.updatedAt - a.updatedAt),
    [apps],
  );

  const { files, frames } = useMemo(
    () => toConversationFileAssets(docs, attachments.entries),
    [docs, attachments.entries],
  );

  return useMemo(
    () => ({
      apps: sortedApps,
      files,
      frames,
      ...toAssetCounts(sortedApps.length, docs.length, attachments),
      hasMoreFiles: attachments.hasMoreFiles,
      hasMoreFrames: attachments.hasMoreFrames,
      loadMoreFiles: attachments.loadMoreFiles,
      loadMoreFrames: attachments.loadMoreFrames,
    }),
    [sortedApps, files, frames, docs.length, attachments],
  );
}
