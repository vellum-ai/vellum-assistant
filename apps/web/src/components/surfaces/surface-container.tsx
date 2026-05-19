
import { CheckCircle, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Surface } from "@/domains/chat/lib/types.js";

interface SurfaceContainerProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
  children: ReactNode;
}

export function SurfaceContainer({ surface, onAction, children }: SurfaceContainerProps) {
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
    <div className="rounded-lg border border-stone-200 bg-white p-4 dark:border-moss-600 dark:bg-moss-700">
      {surface.title && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-title-small text-stone-800 dark:text-stone-200">
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
              <button
                key={action.id}
                type="button"
                disabled={submittingAction !== null}
                onClick={() => handleAction(action.id)}
                className={
                  action.style === "primary"
                    ? "flex items-center gap-2 rounded-lg bg-forest-600 px-4 py-2 text-body-medium-default text-white transition-colors hover:bg-forest-700 disabled:opacity-50"
                    : "flex items-center gap-2 rounded-lg border border-stone-300 bg-white px-4 py-2 text-body-medium-default text-stone-700 transition-colors hover:bg-stone-50 disabled:opacity-50 dark:border-moss-600 dark:bg-moss-700 dark:text-stone-200 dark:hover:bg-moss-600"
                }
              >
                {submittingAction === action.id && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {action.label}
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}
