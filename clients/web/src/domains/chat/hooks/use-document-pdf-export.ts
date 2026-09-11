import { toast } from "@vellumai/design-library/components/toast";
import { useCallback } from "react";

import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import { downloadDocumentPdf } from "../api/surfaces";

/** Shares PDF download and failure feedback across document entry surfaces. */
export function useDocumentPdfExport(
  assistantId: string | null,
  surfaceId: string | null,
  title: string | undefined,
) {
  const { t } = useTranslation("chat");
  return useCallback(async () => {
    if (!assistantId || !surfaceId) {
      return;
    }
    try {
      await downloadDocumentPdf(assistantId, surfaceId, title);
    } catch (error) {
      captureError(error, { context: "document_export" });
      toast.error(t("documentViewerPage.exportFailed"));
    }
  }, [assistantId, surfaceId, title, t]);
}
