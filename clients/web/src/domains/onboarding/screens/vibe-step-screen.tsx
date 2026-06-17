import { ChevronLeft } from "lucide-react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { StepIndicatorDots } from "@/domains/onboarding/components/step-indicator-dots";
import { PERSONALITY_GROUPS } from "@/domains/onboarding/prechat-names";
import { Button } from "@vellumai/design-library/components/button";

interface VibeStepScreenProps {
  selectedGroupId: string | null;
  onGroupChange: (groupId: string | null) => void;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
  currentStep: number;
  totalSteps: number;
}

export function VibeStepScreen({
  selectedGroupId,
  onGroupChange,
  onBack,
  onContinue,
  onSkip,
  currentStep,
  totalSteps,
}: VibeStepScreenProps) {
  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 pb-40 text-[var(--content-default)]">
        <div
          className="grid w-full grid-cols-[auto_1fr_auto] items-center pb-4"
          style={{
            // Match name-step's safe-area handling — iOS status bar /
            // Dynamic Island would otherwise overlap the back button row.
            paddingTop:
              "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 1rem)",
            animation: "fadeInUp 0.3s ease-out 0.1s both",
          }}
        >
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<ChevronLeft />}
            onClick={onBack}
            aria-label="Back"
          />
          <div className="flex justify-center">
            <StepIndicatorDots current={currentStep} total={totalSteps} />
          </div>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>

        <div className="flex flex-1 flex-col items-center pt-4">
          <h1
            className="w-full text-left text-3xl font-semibold tracking-tight"
            style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
          >
            What&apos;s my vibe?
          </h1>

          <p
            className="mt-2 w-full text-left text-body-medium-lighter text-[var(--content-secondary)]"
            style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
          >
            You can change this any time.
          </p>

          <div
            className="mt-8 flex w-full flex-col gap-3"
            style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
          >
            {PERSONALITY_GROUPS.map((group) => {
              const isActive = selectedGroupId === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() =>
                    onGroupChange(isActive ? null : group.id)
                  }
                  aria-pressed={isActive}
                  className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-4 text-left transition-colors ${
                    isActive
                      ? "border-[var(--content-default)] bg-[var(--surface-lift)]"
                      : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]"
                  }`}
                >
                  <span className="text-body-medium-default text-[var(--content-default)]">
                    {group.descriptor}
                  </span>
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors ${
                      isActive
                        ? "border-[var(--content-default)]"
                        : "border-[var(--content-disabled)]"
                    }`}
                  >
                    {isActive && (
                      <span className="h-2.5 w-2.5 rounded-full bg-[var(--content-default)]" />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          className="flex w-full flex-col gap-2 pb-4"
          style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            onClick={onContinue}
            className="h-11 text-base"
          >
            Continue
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            className="h-11 text-base"
          >
            Skip
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
