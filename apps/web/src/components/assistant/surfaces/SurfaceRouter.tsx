
import { CheckCircle, XCircle } from "lucide-react";

import type { Surface } from "@/domains/chat/lib/types.js";

import { BrowserViewSurface } from "@/components/assistant/surfaces/BrowserViewSurface.js";
import { CallSummarySurface } from "@/components/assistant/surfaces/CallSummarySurface.js";
import { CardSurface } from "@/components/assistant/surfaces/CardSurface.js";
import { ConfirmationSurface } from "@/components/assistant/surfaces/ConfirmationSurface.js";
import { DocumentPreviewSurface } from "@/components/assistant/surfaces/DocumentPreviewSurface.js";
import { DynamicPageSurface } from "@/components/assistant/surfaces/DynamicPageSurface.js";
import { FileUploadSurface } from "@/components/assistant/surfaces/FileUploadSurface.js";
import { FormSurface } from "@/components/assistant/surfaces/FormSurface.js";
import { ListSurface } from "@/components/assistant/surfaces/ListSurface.js";
import { SurfaceContainer } from "@/components/assistant/surfaces/SurfaceContainer.js";
import { TableSurface } from "@/components/assistant/surfaces/TableSurface.js";

export interface SurfaceRouterProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
  assistantId?: string | null;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  isToolCallComplete?: boolean;
}

export function SurfaceRouter({
  surface,
  onAction,
  assistantId,
  onOpenApp,
  onOpenDocument,
  isToolCallComplete = true,
}: SurfaceRouterProps) {
  const CHIP_COLLAPSE_TYPES = ["form", "confirmation", "file_upload"];
  if (surface.completed && CHIP_COLLAPSE_TYPES.includes(surface.surfaceType)) {
    const isCancelled = surface.completionSummary === "Cancelled";
    if (isCancelled) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border-element)] bg-[var(--surface-base)] px-3 py-2 text-body-medium-lighter text-[var(--content-secondary)]">
          <XCircle className="h-4 w-4 shrink-0" />
          Cancelled
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 rounded-lg border border-[var(--system-positive-strong)] bg-[var(--system-positive-weak)] px-3 py-2 text-body-medium-lighter text-[var(--system-positive-strong)]">
        <CheckCircle className="h-4 w-4 shrink-0" />
        {surface.completionSummary ?? surface.title ?? "Done"}
      </div>
    );
  }

  switch (surface.surfaceType) {
    case "form":
      return <FormSurface surface={surface} onAction={onAction} />;

    case "confirmation":
      return <ConfirmationSurface surface={surface} onAction={onAction} />;

    case "file_upload":
      return <FileUploadSurface surface={surface} onAction={onAction} />;

    case "card":
      return <CardSurface surface={surface} onAction={onAction} />;

    case "list":
      return <ListSurface surface={surface} onAction={onAction} />;

    case "table":
      return <TableSurface surface={surface} onAction={onAction} />;

    case "dynamic_page":
      return (
        <DynamicPageSurface
          surface={surface}
          onAction={onAction}
          assistantId={assistantId}
          onOpenApp={onOpenApp}
          isToolCallComplete={isToolCallComplete}
        />
      );

    case "call_summary":
      return <CallSummarySurface surface={surface} onAction={onAction} />;

    case "browser_view":
      return <BrowserViewSurface surface={surface} onAction={onAction} />;

    case "document_preview":
      return (
        <DocumentPreviewSurface
          surface={surface}
          onAction={onAction}
          onOpenDocument={onOpenDocument}
        />
      );

    default:
      // Fallback card for unsupported surface types
      return (
        <SurfaceContainer surface={surface} onAction={onAction}>
          <p className="text-body-medium-lighter text-stone-500 dark:text-stone-400">
            {surface.surfaceType
              ? `Unsupported surface type: ${surface.surfaceType}`
              : "Unknown surface"}
          </p>
        </SurfaceContainer>
      );
  }
}
