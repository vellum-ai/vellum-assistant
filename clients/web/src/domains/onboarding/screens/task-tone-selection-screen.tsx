import { Check, ChevronLeft } from "lucide-react";

import { TASK_ICONS } from "@/components/prechat-task-icons";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { isElectron } from "@/runtime/is-electron";
import { PRECHAT_TASKS } from "@/types/prechat-tasks";
import { Button } from "@vellumai/design-library/components/button";

interface TaskToneSelectionScreenProps {
  selectedTasks: Set<string>;
  onChange: (next: Set<string>) => void;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
}

export function TaskToneSelectionScreen({
  selectedTasks,
  onChange,
  onBack,
  onContinue,
  onSkip,
}: TaskToneSelectionScreenProps) {
  const electron = isElectron();

  const toggle = (id: string) => {
    const next = new Set(selectedTasks);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next);
  };

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-11 pb-8 electron-prechat-type" : "px-6 pt-12 pb-40"} text-[var(--content-default)]`}>
        <div
          className="grid w-full grid-cols-[auto_1fr_auto] items-center"
          style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
        >
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1 className={`text-center ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}>
            What are you working on?
          </h1>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>

        <p
          className={`${electron ? "mt-2" : "mt-4"} text-center text-body-medium-lighter text-[var(--content-${electron ? "secondary" : "tertiary"})]`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          Pick the one or two you do most — you can select more if it
          really is all of it.
        </p>

        <div
          className={`${electron ? "mt-6" : "mt-8"} flex w-full flex-col ${electron ? "gap-1" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.2s both" }}
        >
          {PRECHAT_TASKS.map((task) => {
            const Icon = TASK_ICONS[task.iconKey];
            const isSelected = selectedTasks.has(task.id);
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => toggle(task.id)}
                aria-pressed={isSelected}
                className={`group flex w-full cursor-pointer items-center ${electron ? "gap-2 p-3" : "gap-3 px-4 py-3"} rounded-lg border text-left transition-colors ${
                  isSelected
                    ? "border-[var(--primary-base)] bg-[var(--primary-base)]/10"
                    : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]"
                }`}
              >
                <div className="flex w-6 shrink-0 items-center justify-center text-[var(--content-secondary)]">
                  {Icon ? <Icon className="h-4 w-4" /> : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-body-medium-default prechat-md-regular text-[var(--content-default)]">
                    {task.label}
                  </div>
                  <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
                    {task.sublabel}
                  </p>
                </div>
                <div
                  aria-hidden="true"
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
                    isSelected
                      ? "bg-[var(--primary-base)]"
                      : "border-[1.5px] border-[var(--border-element)]"
                  }`}
                >
                  {isSelected ? (
                    <Check className="h-3 w-3 text-[var(--content-inset)]" />
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>

        <div
          className={`${electron ? "mt-auto" : "mt-8"} flex w-full flex-col gap-2`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={selectedTasks.size === 0}
            onClick={onContinue}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            Continue
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            I&apos;ll set this up later
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
