import { CheckCircle, CircleSlash, Loader2, XCircle } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";

import { Button } from "@vellumai/design-library";
import { inferCompletionTone } from "@/domains/chat/completion-tone";
import type { Surface, SurfaceCompletionTone } from "@/domains/chat/types/types";
import { cn } from "@/utils/misc";

interface SurfaceContainerProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void | Promise<void>;
  hideTitle?: boolean;
  /** Extra classes merged onto the card's root element. */
  className?: string;
  children: ReactNode;
}

/**
 * Icon + color for each completion tone. `success` is the affirmative green
 * check; `danger` is a red rejection glyph (denied / blocked); `neutral` is a
 * muted "voided" glyph for terminal states that are not a success and not an
 * active rejection (left unverified / expired / cancelled / timed out).
 */
const COMPLETION_TONE_STYLE: Record<
  SurfaceCompletionTone,
  { Icon: ComponentType<{ className?: string }>; colorClass: string }
> = {
  success: {
    Icon: CheckCircle,
    colorClass: "text-[var(--system-positive-strong)]",
  },
  danger: {
    Icon: XCircle,
    colorClass: "text-[var(--system-negative-strong)]",
  },
  neutral: {
    Icon: CircleSlash,
    colorClass: "text-[var(--content-quiet)]",
  },
};

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

  const completionTone = surface.completionTone ?? inferCompletionTone(surface.completionSummary);
  const { Icon: CompletionIcon, colorClass: completionColorClass } =
    COMPLETION_TONE_STYLE[completionTone];

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
            <span className={cn("flex items-center gap-1.5 text-body-medium-default", completionColorClass)}>
              <CompletionIcon className="h-4 w-4 shrink-0" />
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
