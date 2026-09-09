/**
 * A conversation's assets in the three categories the chat-info panel lists:
 * apps, files (daemon documents plus the attachments that are not camera
 * frames), and camera frames. Frames stay empty while attachments come from
 * the transcript, which cannot see the camera-frame tag.
 *
 * The two daemon queries wait for the org header and retry both the statuses a
 * restarting assistant answers with and a refused connection, so anything that
 * settles failed here is a failure the panel can name, and it is named only
 * once every source has settled.
 */

import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type { AppSummary } from "@/types/app-types";
import type { DisplayAttachment } from "@/types/attachment-types";
import type { DocumentSummary } from "@/types/document-types";
import { shouldRetryDaemonOrNetworkError } from "@/utils/daemon-errors";
import { isTransientNetworkError } from "@/utils/is-transient-network-error";

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

/** How far one daemon query has got, in the terms the panel's status is built from. */
type DaemonSourceState = "ready" | "unresolved" | "failed";

/**
 * A network error thrown while the browser is offline is the one failure still
 * on its way: TanStack refetches every query on reconnect. The same error while
 * the browser is online is a refused connection that has already spent its
 * retries, and it settles like any other answer.
 */
function waitsForReconnect(error: Error | null): boolean {
  return isTransientNetworkError(error) && !onlineManager.isOnline();
}

/**
 * A failed background refetch keeps the last data, so a source is failed or
 * unresolved only while it has nothing to show. Of the errors that leave it
 * with nothing, only the one {@link waitsForReconnect} names is still coming.
 */
function daemonSourceState(query: {
  data: unknown;
  isError: boolean;
  error: Error | null;
}): DaemonSourceState {
  if (query.data !== undefined) {
    return "ready";
  }
  if (query.isError && !waitsForReconnect(query.error)) {
    return "failed";
  }
  return "unresolved";
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

  const attachments = useConversationAttachments({
    assistantId,
    conversationId,
  });

  const apps = appsQuery.data ?? NO_APPS;
  const docs = documentsQuery.data ?? NO_DOCUMENTS;

  const appsState = daemonSourceState(appsQuery);
  const documentsState = daemonSourceState(documentsQuery);
  // The transcript counts as a source too: without it a conversation whose only
  // assets are attachments would read ready and empty until the snapshot lands.
  // Every source settles before one of them speaks for the panel, since a
  // failure named while another source is still coming would be taken back the
  // moment it lands.
  const unresolved =
    appsState === "unresolved" ||
    documentsState === "unresolved" ||
    !attachments.transcriptSettled;
  const failed = appsState === "failed" || documentsState === "failed";
  let status: ConversationAssetsStatus = "ready";
  if (unresolved) {
    status = "pending";
  } else if (failed) {
    status = "error";
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
