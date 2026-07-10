import { CheckCircle, XCircle } from "lucide-react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { INHERENTLY_INTERACTIVE_SURFACE_TYPES } from "@/domains/chat/types/types";
import type { Surface } from "@/domains/chat/types/types";

import { BrowserViewSurface } from "@/domains/chat/components/surfaces/browser-view-surface";
import { CallSummarySurface } from "@/domains/chat/components/surfaces/call-summary-surface";
import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import { ChoiceSurface } from "@/domains/chat/components/surfaces/choice-surface";
import { ConfirmationSurface } from "@/domains/chat/components/surfaces/confirmation-surface";
import { CopyBlockSurface } from "@/domains/chat/components/surfaces/copy-block-surface";
import { DocumentPreviewSurface } from "@/domains/chat/components/surfaces/document-preview-surface";
import { DynamicPageSurface } from "@/domains/chat/components/surfaces/dynamic-page-surface";
import { FileUploadSurface } from "@/domains/chat/components/surfaces/file-upload-surface";
import { FormSurface } from "@/domains/chat/components/surfaces/form-surface";
import { ListSurface } from "@/domains/chat/components/surfaces/list-surface";
import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import { SkillCreatedCard } from "@/domains/chat/components/surfaces/skill-created-card";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { TableSurface } from "@/domains/chat/components/surfaces/table-surface";
import { TaskPreferencesSurface } from "@/domains/chat/components/surfaces/task-preferences-surface";
import { WorkResultSurface } from "@/domains/chat/components/surfaces/work-result-surface";

export interface SurfaceRouterProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
  assistantId?: string | null;
  assistantDisplayName?: string | null;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  /** Tool calls of the message this surface belongs to. Threaded to
   *  `DynamicPageSurface`, which derives whether the surface's originating
   *  tool call has completed before unlocking the app preview. */
  toolCalls?: ChatMessageToolCall[];
  /** Handler for `vellum://` file links clicked inside a `dynamic_page`
   *  surface's sandboxed iframe. Threaded to `DynamicPageSurface`. */
  onVellumLinkClick?: (href: string, linkText: string) => void;
}

export function SurfaceRouter({
  surface,
  onAction,
  assistantId,
  assistantDisplayName,
  onOpenApp,
  onOpenDocument,
  toolCalls,
  onVellumLinkClick,
}: SurfaceRouterProps) {
  if (surface.completed && INHERENTLY_INTERACTIVE_SURFACE_TYPES.includes(surface.surfaceType)) {
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

    case "choice":
      return <ChoiceSurface surface={surface} onAction={onAction} />;

    case "copy_block":
      return <CopyBlockSurface surface={surface} onAction={onAction} />;

    case "oauth_connect":
      return (
        <OAuthConnectSurface
          surface={surface}
          onAction={onAction}
          assistantId={assistantId}
          assistantDisplayName={assistantDisplayName}
        />
      );

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
          toolCalls={toolCalls}
          onVellumLinkClick={onVellumLinkClick}
        />
      );

    case "call_summary":
      return <CallSummarySurface surface={surface} onAction={onAction} />;

    case "browser_view":
      return <BrowserViewSurface surface={surface} onAction={onAction} />;

    case "task_preferences":
      return <TaskPreferencesSurface surface={surface} onAction={onAction} />;

    case "work_result":
      return <WorkResultSurface surface={surface} onAction={onAction} />;

    case "document_preview":
      return (
        <DocumentPreviewSurface
          surface={surface}
          onAction={onAction}
          onOpenDocument={onOpenDocument}
        />
      );

    case "skill_card":
      return <SkillCreatedCard surface={surface} onAction={onAction} />;

    default:
      // Fallback card for unsupported surface types
      return (
        <SurfaceContainer surface={surface} onAction={onAction}>
          <p className="text-body-medium-lighter text-[var(--content-quiet)]">
            {surface.surfaceType
              ? `Unsupported surface type: ${surface.surfaceType}`
              : "Unknown surface"}
          </p>
        </SurfaceContainer>
      );
  }
}
