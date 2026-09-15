import { toast } from "@vellumai/design-library/components/toast";
import { useCallback, type RefObject } from "react";

import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import { downloadDocumentPdf } from "../api/surfaces";
import type { DocumentViewerContainerHandle } from "../components/document-viewer-container";
import { documentRequestScope } from "../document-conversation";

/** Shares PDF download and failure feedback across document entry surfaces. */
export function useDocumentPdfExport(
  assistantId: string | null,
  surfaceId: string | null,
  editorRef: RefObject<DocumentViewerContainerHandle | null>,
) {
  const { t } = useTranslation("chat");
  return useCallback(async () => {
    const editor = editorRef.current;
    if (!assistantId || !surfaceId || !editor) {
      return;
    }
    const scope = documentRequestScope(assistantId);
    try {
      if (!scope.isCurrent()) {
        return;
      }
      const snapshot = await editor.flushPendingSave();
      if (!scope.isCurrent() || editorRef.current !== editor) {
        return;
      }
      await downloadDocumentPdf(assistantId, surfaceId, snapshot.title);
    } catch (error) {
      if (scope.isCurrent() && editorRef.current === editor) {
        captureError(error, { context: "document_export" });
        toast.error(t("documentViewerPage.exportFailed"));
      }
    } finally {
      scope.dispose();
    }
  }, [assistantId, surfaceId, editorRef, t]);
}
