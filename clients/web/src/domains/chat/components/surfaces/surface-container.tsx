import { CheckCircle, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "@vellumai/design-library";
import type { Surface } from "@/domains/chat/types/types";
import { cn } from "@/utils/misc";

interface SurfaceContainerProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void | Promise<void>;
  hideTitle?: boolean;
  /** Extra classes merged onto the card's root element. */
  className?: string;
  children: ReactNode;
}

export function SurfaceContainer({ surface, onAction, hideTitle, className, children }: SurfaceContainerProps) {
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);

  const handleAction = async (actionId: string) => {
    setSubmittingAction(actionId);
    try {
      const actionData = surface.actions?.find((a) => a.id === actionId)?.data;
      await onAction(surface.surfaceId, actionId, actionData);
    } finally {
      setSubmittingAction(null);
    }
  };

  return (
    <div className={cn("rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4", className)}>
      {!hideTitle && surface.title && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-title-small text-[var(--content-strong)]">
            {surface.title}
          </span>
        </div>
      )}

      <div>{children}</div>

      {surface.completed ? (
        surface.completionSummary && (
          <div className="mt-4 flex justify-end">
            <span className="flex items-center gap-1.5 text-body-medium-default text-[var(--system-positive-strong)]">
              <CheckCircle className="h-4 w-4 shrink-0" />
              {surface.completionSummary}
            </span>
          </div>
        )
      ) : (
        surface.actions && surface.actions.length > 0 && (
          <div className="mt-4 flex gap-2">
            {surface.actions.map((action) => (
              <Button
                key={action.id}
                variant={action.style === "primary" ? "primary" : "outlined"}
                disabled={submittingAction !== null}
                onClick={() => handleAction(action.id)}
                leftIcon={
                  submittingAction === action.id
                    ? <Loader2 className="animate-spin" />
                    : undefined
                }
              >
                {action.label}
              </Button>
            ))}
          </div>
        )
      )}
    </div>
  );
}
