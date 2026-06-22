import { ChevronLeft } from "lucide-react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { StepIndicatorDots } from "@/domains/onboarding/components/step-indicator-dots";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

interface NameStepScreenProps {
  userName: string;
  assistantName: string;
  displayedAssistantNames: string[];
  onUserNameChange: (next: string) => void;
  onAssistantNameChange: (next: string) => void;
  onBack?: () => void;
  onContinue: () => void;
  onSkip: () => void;
  currentStep: number;
  totalSteps: number;
}

export function NameStepScreen({
  userName,
  assistantName,
  displayedAssistantNames,
  onUserNameChange,
  onAssistantNameChange,
  onBack,
  onContinue,
  onSkip,
  currentStep,
  totalSteps,
}: NameStepScreenProps) {
  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 pb-40 text-[var(--content-default)]">
        <div
          className="grid w-full grid-cols-[auto_1fr_auto] items-center pb-4"
          style={{
            // Respect the iOS safe-area inset on top of the standard
            // 1rem padding so the header clears the status bar / Dynamic
            // Island instead of sliding under it.
            paddingTop:
              "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 1rem)",
            animation: "fadeInUp 0.3s ease-out 0.1s both",
          }}
        >
          {onBack ? (
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<ChevronLeft />}
              onClick={onBack}
              aria-label="Back"
            />
          ) : (
            <div aria-hidden="true" className="h-8 w-8" />
          )}
          <div className="flex justify-center">
            <StepIndicatorDots current={currentStep} total={totalSteps} />
          </div>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>

        <div className="flex flex-1 flex-col items-center pt-4">
          <h1
            className="text-center text-3xl font-semibold tracking-tight"
            style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
          >
            Let&apos;s get to know each other.
          </h1>

          <p
            className="mt-2 text-center text-body-medium-lighter text-[var(--content-secondary)]"
            style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
          >
            You can change these any time.
          </p>

          <div
            className="mt-8 flex w-full flex-col gap-6"
            style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
          >
            <Input
              label="Your name"
              placeholder="Your name"
              value={userName}
              onChange={(e) => onUserNameChange(e.target.value)}
              fullWidth
            />

            <div className="flex flex-col gap-2">
              <Input
                label="What should I go by?"
                placeholder="Assistant name"
                value={assistantName}
                onChange={(e) => onAssistantNameChange(e.target.value)}
                fullWidth
              />

              <p className="text-body-small-default text-[var(--content-tertiary)]">
                A few to try
              </p>
              <div className="flex flex-wrap gap-2">
                {displayedAssistantNames.map((name) => {
                  const isActive = name === assistantName;
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => onAssistantNameChange(name)}
                      aria-pressed={isActive}
                      className={`cursor-pointer rounded-full border px-3 py-1 text-label-small-default transition-colors ${
                        isActive
                          ? "border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--content-inset)]"
                          : "border-[var(--border-element)] bg-[var(--surface-lift)] text-[var(--content-secondary)] hover:bg-[var(--surface-base)]"
                      }`}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
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
