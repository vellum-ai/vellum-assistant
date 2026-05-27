
import { useCallback, useEffect, useRef, useState } from "react";

import { uploadChatAttachment } from "@/domains/chat/api/messages";
import {
  IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES,
  isAutoResizableImage,
  prepareImageAttachmentForUpload,
} from "@/domains/chat/components/chat-attachments/attachment-image-resize";

/**
 * Size limit enforced on the client before we attempt an upload. The Django
 * backend caps attachments at 50 MB (`_MAX_ATTACHMENT_BYTES`) — we use the same
 * value here so the UI can reject oversized files immediately instead of
 * round-tripping the upload just to surface an error.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Attachment that is currently being uploaded. */
export interface PendingAttachmentUpload {
  kind: "uploading";
  localId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Attachment that successfully finished uploading and has a server-assigned id. */
export interface UploadedAttachment {
  kind: "uploaded";
  localId: string;
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string | null;
}

/** Attachment whose upload failed; kept in the list so the user can retry or dismiss. */
export interface FailedAttachmentUpload {
  kind: "failed";
  localId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  error: string;
}

export type ChatAttachment =
  | PendingAttachmentUpload
  | UploadedAttachment
  | FailedAttachmentUpload;

interface UseChatAttachmentsResult {
  attachments: ChatAttachment[];
  /** Number of attachments currently uploading. */
  uploadingCount: number;
  /** Ids of successfully-uploaded attachments, in insertion order. */
  uploadedIds: string[];
  /** Error produced by the most recent add attempt (e.g. size limit), or null. */
  lastError: string | null;
  addFiles: (files: FileList | File[]) => void;
  removeAttachment: (localId: string) => void;
  /** Clear the list (e.g. after a successful send). */
  reset: () => void;
  /** Clear the transient error produced by `addFiles`. */
  dismissError: () => void;
}

function createLocalId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function uploadLimitLabel(file: File): string {
  return isAutoResizableImage(file) ? "100 MB" : "50 MB";
}

function canQueueFile(file: File): boolean {
  if (file.size <= MAX_ATTACHMENT_BYTES) {
    return true;
  }

  return isAutoResizableImage(file) && file.size <= IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES;
}

/**
 * Hook that tracks a transient list of attachments the user has staged for the
 * next chat message. Files are uploaded immediately on selection; the hook
 * surfaces per-file progress/errors so the composer can render the correct chip
 * state and gate message send on any in-flight uploads.
 */
export function useChatAttachments(assistantId: string | null): UseChatAttachmentsResult {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  // Track blob URLs so we can revoke them when the attachment is removed.
  const previewUrlsRef = useRef<Map<string, string>>(new Map());
  // Track which local uploads have been cancelled so late responses are ignored.
  const cancelledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  // Reset staged attachments when the active assistant changes. Attachment ids
  // are scoped to a specific assistant's upload endpoint, so leaving them in
  // the composer after a switch would send stale ids to the new assistant.
  useEffect(() => {
    setAttachments((prev) => {
      prev.forEach((att) => {
        if (att.kind === "uploading") {
          cancelledRef.current.add(att.localId);
        }
      });
      return [];
    });
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
    setLastError(null);
  }, [assistantId]);

  const revokePreview = useCallback((localId: string) => {
    const url = previewUrlsRef.current.get(localId);
    if (url) {
      URL.revokeObjectURL(url);
      previewUrlsRef.current.delete(localId);
    }
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) {
        return;
      }
      if (!assistantId) {
        setLastError("No active assistant. Please try again.");
        return;
      }

      const oversized: File[] = [];
      const accepted: File[] = [];
      for (const file of list) {
        if (canQueueFile(file)) {
          accepted.push(file);
        } else {
          oversized.push(file);
        }
      }
      const firstOversized = oversized[0];
      if (firstOversized) {
        setLastError(
          oversized.length === 1
            ? `${firstOversized.name} is larger than ${uploadLimitLabel(firstOversized)} and can't be attached.`
            : `${oversized.length} files are too large and can't be attached.`,
        );
      } else {
        setLastError(null);
      }
      if (accepted.length === 0) {
        return;
      }

      const queued: Array<{ pending: PendingAttachmentUpload; file: File }> = accepted.map(
        (file) => ({
          pending: {
            kind: "uploading" as const,
            localId: createLocalId(),
            filename: file.name || "attachment",
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          },
          file,
        }),
      );

      setAttachments((prev) => [...prev, ...queued.map((entry) => entry.pending)]);

      const markFailed = (localId: string, detail: string) => {
        setAttachments((prev) =>
          prev.map((att) =>
            att.localId === localId
              ? ({
                  kind: "failed",
                  localId,
                  filename: att.filename,
                  mimeType: att.mimeType,
                  sizeBytes: att.sizeBytes,
                  error: detail,
                } satisfies FailedAttachmentUpload)
              : att,
          ),
        );
      };

      const updatePendingFile = (localId: string, file: File) => {
        setAttachments((prev) =>
          prev.map((att) =>
            att.localId === localId && att.kind === "uploading"
              ? {
                  ...att,
                  filename: file.name || "attachment",
                  mimeType: file.type || "application/octet-stream",
                  sizeBytes: file.size,
                }
              : att,
          ),
        );
      };

      queued.forEach(({ pending, file }) => {
        void (async () => {
          try {
            const prepared = await prepareImageAttachmentForUpload(file);
            if (cancelledRef.current.has(pending.localId)) {
              cancelledRef.current.delete(pending.localId);
              return;
            }

            if (prepared.status === "failed") {
              if (file.size > MAX_ATTACHMENT_BYTES) {
                markFailed(pending.localId, prepared.error);
                return;
              }
            }

            const uploadFile = prepared.status === "failed" ? file : prepared.file;
            if (uploadFile.size > MAX_ATTACHMENT_BYTES) {
              markFailed(
                pending.localId,
                "This attachment is still larger than 50 MB after resizing. Try a smaller image.",
              );
              return;
            }

            if (prepared.status === "resized") {
              updatePendingFile(pending.localId, uploadFile);
            }

            const result = await uploadChatAttachment(assistantId, uploadFile);
            if (cancelledRef.current.has(pending.localId)) {
              cancelledRef.current.delete(pending.localId);
              return;
            }

            if (!result.ok) {
              markFailed(pending.localId, result.error.detail ?? "Upload failed");
              return;
            }

            let previewUrl: string | null = null;
            try {
              previewUrl = URL.createObjectURL(uploadFile);
              previewUrlsRef.current.set(pending.localId, previewUrl);
            } catch {
              previewUrl = null;
            }

            setAttachments((prev) =>
              prev.map((att) =>
                att.localId === pending.localId
                  ? ({
                      kind: "uploaded",
                      localId: pending.localId,
                      id: result.id,
                      filename: uploadFile.name || "attachment",
                      mimeType: uploadFile.type || "application/octet-stream",
                      sizeBytes: uploadFile.size,
                      previewUrl,
                    } satisfies UploadedAttachment)
                  : att,
              ),
            );
          } catch {
            if (cancelledRef.current.has(pending.localId)) {
              cancelledRef.current.delete(pending.localId);
              return;
            }
            markFailed(pending.localId, "Upload failed");
          }
        })();
      });
    },
    [assistantId],
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      setAttachments((prev) => {
        const target = prev.find((att) => att.localId === localId);
        if (target && target.kind === "uploading") {
          cancelledRef.current.add(localId);
        }
        return prev.filter((att) => att.localId !== localId);
      });
      revokePreview(localId);
    },
    [revokePreview],
  );

  const reset = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((att) => {
        if (att.kind === "uploading") {
          cancelledRef.current.add(att.localId);
        }
      });
      return [];
    });
    // Intentionally do NOT revoke preview blob URLs here. After a successful
    // send the uploaded attachment chip is rendered inside the sent user
    // message bubble, which still needs those URLs. They get revoked on
    // assistant switch (below) and on hook unmount (useEffect cleanup above),
    // both of which correspond to the message bubble also leaving the DOM.
    setLastError(null);
  }, []);

  const dismissError = useCallback(() => {
    setLastError(null);
  }, []);

  const uploadingCount = attachments.reduce(
    (acc, att) => (att.kind === "uploading" ? acc + 1 : acc),
    0,
  );
  const uploadedIds = attachments
    .filter((att): att is UploadedAttachment => att.kind === "uploaded")
    .map((att) => att.id);

  return {
    attachments,
    uploadingCount,
    uploadedIds,
    lastError,
    addFiles,
    removeAttachment,
    reset,
    dismissError,
  };
}
