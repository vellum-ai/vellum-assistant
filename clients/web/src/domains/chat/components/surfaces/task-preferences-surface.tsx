import { Check, MessageSquare } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";

import { Button } from "@vellumai/design-library";

import { TASK_ICONS } from "@/components/prechat-task-icons";
import type { Surface } from "@/domains/chat/types/types";
import { PRECHAT_TASKS } from "@/types/prechat-tasks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskPreferencesSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Multi-select task-category grid surface. Renders the same task tiles as
 * `OnboardingChoiceCard`'s task-selection phase, but presented inline in the
 * chat transcript as a daemon-driven surface that the LLM can spawn from a
 * tool call. Submits selections back through `onAction("submit", { tasks,
 * customText })`.
 */
export function TaskPreferencesSurface({
  surface,
  onAction,
}: TaskPreferencesSurfaceProps) {
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [otherSelected, setOtherSelected] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  if (surface.completed) {
    return null;
  }

  const toggleTask = (taskId: string) => {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const toggleOther = () => {
    setOtherSelected((prev) => {
      const next = !prev;
      if (next) {
        // Focus textarea after React re-renders with it visible.
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      } else {
        setOtherText("");
      }
      return next;
    });
  };

  const canSubmit =
    selectedTasks.size > 0 || (otherSelected && otherText.trim().length > 0);

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onAction(surface.surfaceId, "submit", {
        tasks: Array.from(selectedTasks),
        customText: otherText.trim() || undefined,
      });
    } catch {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-element)] bg-[var(--surface-overlay)] p-4">
      <div className="flex flex-col gap-1">
        <div className="text-body-medium-default text-[var(--content-default)]">
          {surface.title ?? "What can I help with?"}
        </div>
        <div className="text-label-small-default text-[color:var(--content-tertiary)]">
          Select all that apply
        </div>
      </div>

      <div className="grid auto-rows-fr grid-cols-2 gap-2">
        {PRECHAT_TASKS.map((task) => {
          const Icon = TASK_ICONS[task.iconKey];
          const isSelected = selectedTasks.has(task.id);
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => toggleTask(task.id)}
              aria-pressed={isSelected}
              className={[
                "flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors",
                isSelected
                  ? "border-[var(--primary-base)] bg-[var(--primary-base)]/10"
                  : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]",
              ].join(" ")}
            >
              <div className="flex w-full items-center justify-between">
                <div className="flex h-5 w-5 items-center justify-center text-[var(--content-secondary)]">
                  {Icon ? <Icon className="h-4 w-4" /> : null}
                </div>
                {isSelected && (
                  <div
                    aria-hidden="true"
                    className="flex h-4 w-4 items-center justify-center rounded-sm bg-[var(--primary-base)]"
                  >
                    <Check className="h-3 w-3 text-[var(--content-inset)]" />
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <div className="text-body-small-default text-[var(--content-default)]">
                  {task.label}
                </div>
                <div className="text-label-small-default text-[var(--content-tertiary)]">
                  {task.sublabel}
                </div>
              </div>
            </button>
          );
        })}

        {/* "Other" tile — `div` with `role="button"` rather than a native
           `<button>` because the inner textarea swallows Enter/Space, and a
           parent button would re-fire its own click on Space-keyup while the
           user is typing. */}
        <div
          role="button"
          tabIndex={0}
          onClick={toggleOther}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleOther();
            }
          }}
          aria-pressed={otherSelected}
          className={[
            "col-span-2 flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
            otherSelected
              ? "border-[var(--primary-base)] bg-[var(--primary-base)]/10"
              : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]",
          ].join(" ")}
        >
          <div className="flex flex-1 items-start gap-2.5">
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-secondary)]" />
            {otherSelected ? (
              <textarea
                ref={textareaRef}
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Describe what you need help with..."
                className="w-full resize-none overflow-hidden bg-transparent text-body-medium-default text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:outline-none"
                style={{ fieldSizing: "content" } as CSSProperties}
                rows={1}
              />
            ) : (
              <div className="flex flex-col">
                <div className="text-body-medium-default text-[var(--content-default)]">
                  Other
                </div>
                <div className="text-label-small-default text-[var(--content-tertiary)]">
                  something else entirely
                </div>
              </div>
            )}
          </div>
          {otherSelected && (
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--primary-base)]">
              <Check className="h-3 w-3 text-[var(--content-inset)]" />
            </div>
          )}
        </div>
      </div>

      <Button
        variant="primary"
        size="regular"
        fullWidth
        disabled={!canSubmit || isSubmitting}
        onClick={handleSubmit}
      >
        Continue
      </Button>
    </div>
  );
}
