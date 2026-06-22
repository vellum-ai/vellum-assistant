
import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import type { Surface } from "@/domains/chat/types/types";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfirmationSurfaceData {
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ConfirmationSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConfirmationSurface({ surface, onAction }: ConfirmationSurfaceProps) {
  const data = surface.data as unknown as ConfirmationSurfaceData;
  const [isSubmitting, setIsSubmitting] = useState(false);

  const confirmActionId =
    surface.actions?.find((a) => a.id === "confirm")?.id
    ?? surface.actions?.find((a) => a.style === "primary" || a.style === "destructive")?.id
    ?? "confirm";
  const cancelActionId =
    surface.actions?.find((a) => a.id === "cancel")?.id
    ?? surface.actions?.find((a) => a.style === "secondary")?.id
    ?? "cancel";

  const confirmLabel = data.confirmLabel ?? "Confirm";
  const cancelLabel = data.cancelLabel ?? "Cancel";

  const handleConfirm = useCallback(async () => {
    setIsSubmitting(true);
    try {
      await onAction(surface.surfaceId, confirmActionId, {});
    } catch {
      setIsSubmitting(false);
    }
  }, [onAction, surface.surfaceId, confirmActionId]);

  const handleCancel = useCallback(async () => {
    setIsSubmitting(true);
    try {
      await onAction(surface.surfaceId, cancelActionId, {});
    } catch {
      setIsSubmitting(false);
    }
  }, [onAction, surface.surfaceId, cancelActionId]);

  return (
    <div
      className={`rounded-lg border p-4 ${
        data.destructive
          ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)]"
          : "border-[var(--border-element)] bg-[var(--surface-overlay)]"
      }`}
    >
      {surface.title && (
        <div className="mb-3 flex items-center gap-2">
          {data.destructive && (
            <AlertTriangle className="h-4 w-4 text-[var(--system-negative-strong)]" />
          )}
          <span className="text-title-small text-[var(--content-default)]">
            {surface.title}
          </span>
        </div>
      )}

      <ChatMarkdownMessage
        content={data.message}
        className={`text-body-medium-default ${
          data.destructive
            ? "text-[var(--system-negative-strong)]"
            : "text-[var(--content-default)]"
        }`}
      />

      {data.detail && (
        <ChatMarkdownMessage
          content={data.detail}
          className="mt-1 text-body-medium-lighter text-[var(--content-secondary)]"
        />
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={isSubmitting}
          onClick={handleConfirm}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-body-medium-default transition-colors disabled:opacity-50 ${
            data.destructive
              ? "bg-[var(--system-negative-strong)] text-white hover:opacity-90"
              : "bg-[var(--primary-base)] text-[var(--content-inset)] hover:opacity-90"
          }`}
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </button>
        <button
          type="button"
          disabled={isSubmitting}
          onClick={handleCancel}
          className="flex items-center gap-2 rounded-lg border border-[var(--border-element)] bg-[var(--surface-base)] px-4 py-2 text-body-medium-default text-[var(--content-default)] transition-colors hover:bg-[var(--surface-active)] disabled:opacity-50"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
