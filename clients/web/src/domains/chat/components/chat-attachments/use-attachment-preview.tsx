import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { AttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-preview-modal";

interface UseAttachmentPreviewResult {
  /**
   * Open the full-screen preview modal for the given attachment. Pass its
   * position in `attachments` when the list can hold two attachments with the
   * same id (legacy `rehydrated:N` rows), which the modal's id lookup cannot
   * tell apart.
   */
  openPreview: (
    attachment: DisplayAttachment,
    index?: number,
    trigger?: HTMLElement | null,
  ) => void;
  /** The rendered {@link AttachmentPreviewModal}, or `null` when nothing is
   *  open. Render this somewhere stable in the consuming component. */
  previewModal: ReactNode;
}

interface OpenPreview {
  attachment: DisplayAttachment;
  /** The caller's position, when it gave one; the modal falls back to its id. */
  index?: number;
  key?: string;
  trigger?: HTMLElement;
}

interface AttachmentPreviewOptions {
  /** Changing scope closes a preview opened for a different rendered block. */
  scopeKey?: string;
  /** Focus target used when the opening tile disappeared while previewing. */
  getFallbackFocus?: () => HTMLElement | null;
}

/**
 * Owns the shared full-screen-preview plumbing for the attachment renderers
 * (the message squares and the composer strip): the open/close state and the
 * {@link AttachmentPreviewModal} element. Consumers call `openPreview(att)`
 * from an item's click handler and render `previewModal`.
 *
 * When multiple attachments are present, the modal renders prev/next gallery
 * navigation so the user can arrow between sibling images without closing.
 *
 * @param assistantId Forwarded to {@link AttachmentPreviewModal} so it can
 *   lazily fetch attachment content when `previewUrl` is missing.
 * @param attachments The full list of sibling attachments for gallery nav.
 * @param attachmentKeys Stable UI identities aligned with a changing list.
 */
export function useAttachmentPreview(
  assistantId?: string | null,
  attachments?: DisplayAttachment[],
  attachmentKeys?: readonly string[],
  options?: AttachmentPreviewOptions,
): UseAttachmentPreviewResult {
  const [preview, setPreview] = useState<OpenPreview | null>(null);
  const scopeKey = options?.scopeKey;
  const getFallbackFocus = options?.getFallbackFocus;

  useEffect(() => {
    setPreview(null);
  }, [scopeKey]);

  const openPreview = useCallback(
    (
      attachment: DisplayAttachment,
      index?: number,
      trigger?: HTMLElement | null,
    ) =>
      setPreview({
        attachment,
        index,
        key: index === undefined ? undefined : attachmentKeys?.[index],
        trigger:
          trigger ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined),
      }),
    [attachmentKeys],
  );
  const navigatePreview = useCallback(
    (attachment: DisplayAttachment, index: number) =>
      setPreview((current) => ({
        attachment,
        index,
        key: attachmentKeys?.[index],
        trigger: current?.trigger,
      })),
    [attachmentKeys],
  );
  const handleClose = useCallback(() => {
    const target =
      preview?.trigger?.isConnected === true
        ? preview.trigger
        : getFallbackFocus?.();
    setPreview(null);
    queueMicrotask(() => target?.focus());
  }, [preview, getFallbackFocus]);

  const keyedIndex =
    preview?.key === undefined
      ? undefined
      : attachmentKeys?.indexOf(preview.key);
  const attachment =
    keyedIndex === undefined
      ? preview?.attachment
      : (attachments?.[keyedIndex] ?? preview?.attachment);

  const previewModal =
    preview && attachment ? (
      <AttachmentPreviewModal
        open
        onClose={handleClose}
        attachment={attachment}
        currentIndex={keyedIndex ?? preview.index}
        assistantId={assistantId}
        siblingAttachments={keyedIndex === -1 ? undefined : attachments}
        onNavigate={navigatePreview}
      />
    ) : null;

  return { openPreview, previewModal };
}
