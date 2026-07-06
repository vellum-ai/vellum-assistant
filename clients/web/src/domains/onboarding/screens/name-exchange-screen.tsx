import { ChevronLeft } from "lucide-react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { isElectron } from "@/runtime/is-electron";
import {
    PERSONALITY_GROUPS,
    type PersonalityGroup,
} from "@/domains/onboarding/prechat-names";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

import { MOBILE_INPUT_NO_ZOOM } from "@/domains/onboarding/onboarding-step-layout";

interface NameExchangeScreenProps {
  userName: string;
  assistantName: string;
  selectedGroupId: string | null;
  displayedAssistantNames: string[];
  onUserNameChange: (next: string) => void;
  onAssistantNameChange: (next: string) => void;
  onGroupChange: (groupId: string | null) => void;
  onBack?: () => void;
  onComplete: () => void;
  onSkip: () => void;
}

export function NameExchangeScreen({
  userName,
  assistantName,
  selectedGroupId,
  displayedAssistantNames,
  onUserNameChange,
  onAssistantNameChange,
  onGroupChange,
  onBack,
  onComplete,
  onSkip,
}: NameExchangeScreenProps) {
  const electron = isElectron();

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div
        className={`mx-auto flex w-full max-w-md flex-col items-center ${electron ? "min-h-full px-8 pt-11 pb-8 electron-prechat-type" : "px-6 pt-12 pb-40"} text-[var(--content-default)]`}
      >
        <div
          className={`grid w-full items-center ${onBack ? "grid-cols-[auto_1fr_auto]" : ""}`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
        >
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)]"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : null}
          <h1 className={`text-center ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}>
            Let&apos;s get to know each other.
          </h1>
          {onBack ? <div aria-hidden="true" className="h-8 w-8" /> : null}
        </div>

        <p
          className="mt-2 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          You can change these any time.
        </p>

        <div
          className={`${electron ? "mt-6" : "mt-8"} flex w-full flex-col ${electron ? "gap-4" : "gap-6"}`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
        >
          <Input
            label="Your name"
            placeholder="Your name"
            value={userName}
            onChange={(e) => onUserNameChange(e.target.value)}
            className={MOBILE_INPUT_NO_ZOOM}
            fullWidth
          />

          <div className="flex flex-col gap-2">
            <Input
              label="What should I go by?"
              placeholder="Assistant name"
              value={assistantName}
              onChange={(e) => onAssistantNameChange(e.target.value)}
              className={MOBILE_INPUT_NO_ZOOM}
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

          <div className="flex flex-col gap-2">
            <p className="text-body-small-default text-[var(--content-secondary)]">
              Pick a vibe
            </p>
            <div className="grid grid-cols-2 gap-2">
              {PERSONALITY_GROUPS.map((group) => (
                <VibeCard
                  key={group.id}
                  group={group}
                  isActive={selectedGroupId === group.id}
                  onToggle={() =>
                    onGroupChange(
                      selectedGroupId === group.id ? null : group.id,
                    )
                  }
                />
              ))}
            </div>
          </div>
        </div>

        <div
          className={`${electron ? "mt-auto" : "mt-8"} flex w-full flex-col gap-2`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            onClick={onComplete}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            Let&apos;s go
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            Skip
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}

function VibeCard({
  group,
  isActive,
  onToggle,
}: {
  group: PersonalityGroup;
  isActive: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isActive}
      aria-label={`${group.label}, ${group.descriptor}`}
      className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors ${
        isActive
          ? "border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--content-inset)]"
          : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]"
      }`}
    >
      <span
        className={`text-body-medium-default ${
          isActive
            ? "text-[var(--content-inset)]"
            : "text-[var(--content-default)]"
        }`}
      >
        {group.descriptor}
      </span>
      <span
        className={`text-body-small-default ${
          isActive
            ? "text-[var(--content-inset)] opacity-60"
            : "text-[var(--content-tertiary)]"
        }`}
      >
        {group.tagline}
      </span>
    </button>
  );
}
