import { ArrowUpRight, FileText } from "lucide-react";
import type { KeyboardEvent } from "react";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";

interface DocumentPreviewSurfaceData {
  documentName: string;
  documentSurfaceId: string;
  content?: string;
  mimeType?: string;
}

interface DocumentPreviewSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
}

export function DocumentPreviewSurface({
  surface,
  onAction,
  onOpenDocument,
}: DocumentPreviewSurfaceProps) {
  const data: DocumentPreviewSurfaceData = {
    documentName: (surface.data.documentName as string) ?? (surface.data.title as string) ?? "",
    documentSurfaceId: (surface.data.surfaceId as string) ?? "",
    content: surface.data.content as string | undefined,
    mimeType: surface.data.mimeType as string | undefined,
  };
  const hasOpenAction = surface.actions && surface.actions.length > 0;
  const isClickable = hasOpenAction || onOpenDocument != null;

  const handleClick = () => {
    if (hasOpenAction) {
      const action = surface.actions?.[0];
      if (action) {
        onAction(surface.surfaceId, action.id);
      }
    } else if (onOpenDocument && data.documentSurfaceId) {
      onOpenDocument(data.documentSurfaceId);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  const surfaceWithoutTitle = { ...surface, title: undefined };

  return (
    <div className="max-w-sm">
    <SurfaceContainer surface={surfaceWithoutTitle} onAction={onAction}>
      <div
        role={isClickable ? "button" : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onClick={isClickable ? handleClick : undefined}
        onKeyDown={isClickable ? handleKeyDown : undefined}
        className={
          isClickable
            ? "-m-2 cursor-pointer rounded-lg p-2"
            : undefined
        }
      >
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-[var(--content-quiet)]" />
          <h3 className="text-title-small text-[var(--content-strong)]">
            {data.documentName}
          </h3>
          {data.mimeType && (
            <span className="rounded-full bg-[var(--tag-bg-neutral)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
              {data.mimeType}
            </span>
          )}
          {isClickable && (
            <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--content-faint)]" />
          )}
        </div>

        {data.content && (
          <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-default)]">
            {data.content}
          </pre>
        )}
      </div>
    </SurfaceContainer>
    </div>
  );
}
