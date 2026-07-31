/**
 * In-chat onboarding card that morphs between two phases:
 *
 * 1. **choice** — Two buttons: "I have something specific" (calls
 *    `onSelectSpecific`) and "Let's chat" (transitions to task selection).
 * 2. **taskSelection** — Multi-select grid of task categories from the
 *    `PRECHAT_TASKS` catalog with a "Continue" submit button.
 *
 * Rendered in the chat transcript after the canned greeting on iOS.
 */

import { Check, MessageSquare } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { TASK_ICONS } from "@/components/prechat-task-icons";
import { PRECHAT_TASKS } from "@/types/prechat-tasks";
import { Button, Card } from "@vellumai/design-library";

export interface OnboardingChoiceCardProps {
  onSelectSpecific: () => void;
  onSubmitTasks: (tasks: Set<string>, customText?: string) => void;
}

export function OnboardingChoiceCard({
  onSelectSpecific,
  onSubmitTasks,
}: OnboardingChoiceCardProps): ReactNode {
  const [phase, setPhase] = useState<"choice" | "taskSelection">("choice");
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(
    new Set<string>(),
  );
  const [otherSelected, setOtherSelected] = useState(false);
  const [otherText, setOtherText] = useState("");
  const otherInputRef = useRef<HTMLTextAreaElement>(null);

  const toggle = (id: string) => {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleOther = () => {
    if (otherSelected) {
      setOtherSelected(false);
      setOtherText("");
    } else {
      setOtherSelected(true);
      requestAnimationFrame(() => otherInputRef.current?.focus());
    }
  };

  const hasSelection =
    selectedTasks.size > 0 || (otherSelected && otherText.trim().length > 0);

  return (
    <div
      className="max-w-sm"
      style={{ animation: "fadeInUp 0.3s ease-out both" }}
    >
      <Card>
        {phase === "choice" ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="outlined"
              size="regular"
              fullWidth
              onClick={onSelectSpecific}
            >
              I have something specific
            </Button>
            <Button
              variant="primary"
              size="regular"
              fullWidth
              onClick={() => setPhase("taskSelection")}
            >
              Let&apos;s chat
            </Button>
          </div>
        ) : (
          <div
            className="flex flex-col gap-3"
            style={{ animation: "fadeInUp 0.2s ease-out both" }}
          >
            <div>
              <div className="text-body-medium-default text-[color:var(--content-default)]">
                What can I help with?
              </div>
              <div className="mt-0.5 text-label-small-default text-[color:var(--content-tertiary)]">
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
                    onClick={() => toggle(task.id)}
                    aria-pressed={isSelected}
                    className={`flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors ${
                      isSelected
                        ? "border-[var(--primary-base)] bg-[var(--primary-base)]/10"
                        : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]"
                    }`}
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

              <div
                role="button"
                tabIndex={0}
                onClick={toggleOther}
                onKeyDown={(e) => {
                  if (
                    (e.key === "Enter" || e.key === " ") &&
                    e.target === e.currentTarget
                  ) {
                    e.preventDefault();
                    toggleOther();
                  }
                }}
                aria-pressed={otherSelected}
                className={`col-span-2 flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors ${
                  otherSelected
                    ? "border-[var(--primary-base)] bg-[var(--primary-base)]/10"
                    : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]"
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex h-5 w-5 items-center justify-center text-[var(--content-secondary)]">
                    <MessageSquare className="h-4 w-4" />
                  </div>
                  {otherSelected && (
                    <div
                      aria-hidden="true"
                      className="flex h-4 w-4 items-center justify-center rounded-sm bg-[var(--primary-base)]"
                    >
                      <Check className="h-3 w-3 text-[var(--content-inset)]" />
                    </div>
                  )}
                </div>
                {otherSelected ? (
                  <textarea
                    ref={otherInputRef}
                    value={otherText}
                    onChange={(e) => setOtherText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    rows={1}
                    placeholder="What do you need help with?"
                    className="mt-0.5 w-full resize-none overflow-hidden border-none bg-transparent p-0 text-body-small-default text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:outline-none"
                    style={{ fieldSizing: "content" } as CSSProperties}
                  />
                ) : (
                  <div>
                    <div className="text-body-small-default text-[var(--content-default)]">
                      Other
                    </div>
                    <div className="text-label-small-default text-[var(--content-tertiary)]">
                      something else
                    </div>
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="primary"
              size="regular"
              fullWidth
              disabled={!hasSelection}
              onClick={() =>
                onSubmitTasks(
                  selectedTasks,
                  otherSelected ? otherText.trim() : undefined,
                )
              }
            >
              Continue
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
