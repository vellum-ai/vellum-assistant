import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import {
  appsGetOptions,
  appsGetQueryKey,
  documentsGetOptions,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  conversationAssetSourceState,
  retryConversationAssetQuery,
  summarizeAssetSources,
  type ConversationAssetSource,
  type ConversationAssetSourceState,
} from "@/lib/conversation-asset-sources";
import {
  type ConversationAttachmentEntry,
  useConversationAttachments,
} from "@/domains/chat/hooks/use-conversation-attachments";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type { AppSummary } from "@/types/app-types";
import type { DisplayAttachment } from "@/types/attachment-types";
import type { DocumentSummary } from "@/types/document-types";
import { shouldRetryDaemonOrNetworkError } from "@/utils/daemon-errors";

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

/** Overall loading state; source details preserve partial results and failures. */
export type ConversationAssetsStatus = "pending" | "error" | "ready";

interface ConversationAssets {
  apps: AppSummary[];
  /** Documents, newest first, then the attachments that are not frames. */
  files: ConversationFileAsset[];
  frames: ConversationFileAsset[];
  counts: { apps: number; files: number; frames: number };
  /** Sum of known totals; display as exact only when `countExact` is true. */
  count: number;
  /**
   * Whether the categories can be believed yet. An empty category means
   * "nothing here" only once this reads `"ready"`.
   */
  status: ConversationAssetsStatus;
  allFailed: boolean;
  sources: Record<ConversationAssetSource, ConversationAssetSourceState>;
  countsExact: { apps: boolean; files: boolean; frames: boolean };
  countExact: boolean;
  loadedCount: number;
  retrySource: (source: ConversationAssetSource) => void;
  retryFailedSources: () => void;
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
  // A request sent before the org header can be produced, or through a daemon
  // restart, fails for a reason the conversation has nothing to do with. The
  // gate and the retries keep both out of the settled failures below, whether
  // the restart answers a status or refuses the connection.
  const isOrgReady = useIsOrgReady();
  const appsQuery = useQuery({
    ...appsGetOptions({
      path: { assistant_id: assistantId },
      query: { conversationId },
    }),
    enabled: isOrgReady,
    retry: shouldRetryDaemonOrNetworkError,
    select: (data) => data.apps,
  });
  const documentsQuery = useQuery({
    ...documentsGetOptions({
      path: { assistant_id: assistantId },
      query: { conversationId },
    }),
    enabled: isOrgReady,
    retry: shouldRetryDaemonOrNetworkError,
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

  // The attachment hook owns list invalidation and retry.
  const attachments = useConversationAttachments({
    assistantId,
    conversationId,
    refreshKey,
  });

  const apps = appsQuery.data ?? NO_APPS;
  const docs = documentsQuery.data ?? NO_DOCUMENTS;

  const sources = {
    apps: conversationAssetSourceState(appsQuery),
    documents: conversationAssetSourceState(documentsQuery),
    attachments: attachments.filesState,
    frames: attachments.framesState,
  };
  const summary = summarizeAssetSources(Object.values(sources));
  const retrySource = (source: ConversationAssetSource) => {
    if (source === "apps") {
      retryConversationAssetQuery(appsQuery);
    } else if (source === "documents") {
      retryConversationAssetQuery(documentsQuery);
    } else if (source === "attachments") {
      attachments.retryFiles();
    } else {
      attachments.retryFrames();
    }
  };
  const retryFailedSources = () => {
    for (const source of Object.keys(sources) as ConversationAssetSource[]) {
      retrySource(source);
    }
  };

  const sortedApps = useMemo(
    () => [...apps].sort((a, b) => b.updatedAt - a.updatedAt),
    [apps],
  );

  const { files, frames } = useMemo(
    () => toConversationFileAssets(docs, attachments.entries),
    [docs, attachments.entries],
  );

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
    loadedCount: sortedApps.length + files.length + frames.length,
    status: summary.status,
    allFailed: summary.allFailed,
    sources,
    countsExact: {
      apps: summarizeAssetSources([sources.apps]).exact,
      files: summarizeAssetSources([sources.documents, sources.attachments])
        .exact,
      frames: summarizeAssetSources([sources.frames]).exact,
    },
    countExact: summary.exact,
    retrySource,
    retryFailedSources,
    hasMoreFiles: attachments.hasMoreFiles,
    hasMoreFrames: attachments.hasMoreFrames,
    loadMoreFiles: attachments.loadMoreFiles,
    loadMoreFrames: attachments.loadMoreFrames,
  };
}
