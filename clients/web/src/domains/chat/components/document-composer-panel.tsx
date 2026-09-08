import { Check } from "lucide-react";
import { useEffect, useRef } from "react";

import { Typography } from "@vellumai/design-library";

import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useDocumentComposerSubmit } from "@/domains/chat/hooks/use-document-composer-submit";
import type { DocumentConversationRef } from "@/domains/chat/utils/document-conversation";
import { useTranslation } from "@/i18n";

export interface DocumentComposerPanelProps {
  assistantId: string | null;
  doc: DocumentConversationRef | null;
  /**
   * Bottom padding for the safe area below the composer. Defaults to
   * `MobileDocumentOverlay`'s keyboard-aware `--overlay-safe-area-bottom`
   * variable; a caller that is not that fixed, keyboard-tracking shell (the
   * standalone document route) has no CSS variable to read and instead
   * passes the same keyboard-aware value directly, computed via
   * `useOverlaySafeAreaBottomInset`.
   */
  bottomInset?: string;
}

/**
 * The composer pinned below a document editor, wired to
 * `useDocumentComposerSubmit` and the `"document"` composer-store slot.
 * Shared by `MobileDocumentOverlay` (the in-chat overlay) and, on mobile,
 * `DocumentViewerPage` (the standalone `/documents/:surfaceId` route), so the
 * two entry points send through one wiring rather than two.
 */
export function DocumentComposerPanel({
  assistantId,
  doc,
  bottomInset = "var(--overlay-safe-area-bottom)",
}: DocumentComposerPanelProps) {
  const { t } = useTranslation("chat");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { status, submit } = useDocumentComposerSubmit({ assistantId, doc });

  // Clear the document slot's staged text/attachments whenever the target
  // document changes or the panel unmounts, so a draft typed for one
  // document never carries into another. A host that remounts this panel
  // per document (`MobileDocumentOverlay`'s `key` prop) gets this for free
  // from React, but a host that reuses one panel instance across documents
  // (the standalone `/documents/:surfaceId` route, whose route params can
  // change without remounting `DocumentViewerPage`) has no other hook to
  // clear on, so the cleanup lives here where both hosts share it.
  const surfaceId = doc?.surfaceId ?? null;
  useEffect(() => {
    return () => {
      useComposerStore.getState().setInput("", "document");
      useComposerStore.getState().fullReset("document");
    };
  }, [surfaceId]);

  if (!assistantId) {
    return null;
  }

  const sending = status === "sending";

  return (
    <div className="shrink-0 px-3 pt-2" style={{ paddingBottom: bottomInset }}>
      {status === "sent" && (
        <div className="flex items-center justify-center gap-1 pb-1 text-[var(--content-tertiary)]">
          <Check size={12} className="shrink-0" />
          <Typography
            variant="label-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {t("documentComposer.sent")}
          </Typography>
        </div>
      )}
      <ChatComposer
        slot="document"
        assistantId={assistantId}
        inputRef={inputRef}
        typingDisabled={sending}
        sendDisabled={sending}
        isAssistantBusy={false}
        onStopGenerating={() => {}}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onAddAttachmentFiles={(files) => {
          useComposerStore
            .getState()
            .addFiles(files, assistantId, "document");
        }}
      />
    </div>
  );
}
