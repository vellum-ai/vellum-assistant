/**
 * Research-onboarding front door — collects first name, last name, and
 * occupation, then hands off to the assistant to research the person.
 *
 * SPIKE — research-onboarding flow.
 *
 * Presentational only: owns local field state and validation, delegates the
 * context build + handoff navigation to the caller via `onSubmit`.
 */

import { useState } from "react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

export interface ResearchOnboardingValues {
  firstName: string;
  lastName: string;
  occupation: string;
}

interface ResearchOnboardingScreenProps {
  initialFirstName?: string;
  initialLastName?: string;
  onSubmit: (values: ResearchOnboardingValues) => void;
}

export function ResearchOnboardingScreen({
  initialFirstName = "",
  initialLastName = "",
  onSubmit,
}: ResearchOnboardingScreenProps) {
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [occupation, setOccupation] = useState("");

  // First name + occupation are the minimum signal worth researching on.
  const canSubmit =
    firstName.trim().length > 0 && occupation.trim().length > 0;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit({ firstName, lastName, occupation });
  }

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <form
        className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 pb-40 text-[var(--content-default)]"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="flex flex-1 flex-col items-center pt-16">
          <h1
            className="text-center text-3xl font-semibold tracking-tight"
            style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
          >
            Let&apos;s start with you.
          </h1>

          <p
            className="mt-2 text-center text-body-medium-lighter text-[var(--content-secondary)]"
            style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
          >
            A few details so I can get to know you before we dive in.
          </p>

          <div
            className="mt-8 flex w-full flex-col gap-6"
            style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
          >
            <Input
              label="First name"
              placeholder="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoFocus
              fullWidth
            />
            <Input
              label="Last name"
              placeholder="Last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              fullWidth
            />
            <Input
              label="What do you do?"
              placeholder="e.g. Product designer at a fintech startup"
              value={occupation}
              onChange={(e) => setOccupation(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        <div
          className="flex w-full flex-col gap-2 pb-4"
          style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
        >
          <Button
            type="submit"
            variant="primary"
            size="regular"
            fullWidth
            disabled={!canSubmit}
            className="h-11 text-base"
          >
            Continue
          </Button>
        </div>
      </form>
    </OnboardingLayout>
  );
}
