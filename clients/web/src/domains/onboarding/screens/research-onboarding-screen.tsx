/**
 * Research-onboarding front door — collects name, role, and hobbies, then
 * hands off to the assistant to research the person.
 *
 * SPIKE — research-onboarding flow.
 *
 * Presentational only: owns local field state and validation, delegates the
 * context build + handoff navigation to the caller via `onSubmit`.
 */

import { useState } from "react";
import { ArrowRight } from "lucide-react";

import { OnboardingEdgeCharacters } from "@/domains/onboarding/components/onboarding-edge-characters";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { TagAutocompleteInput } from "@/domains/onboarding/components/onboarding-autocomplete";
import { HOBBY_SUGGESTIONS } from "@/domains/onboarding/onboarding-suggestions";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

export interface ResearchOnboardingValues {
  firstName: string;
  lastName: string;
  role: string;
  hobbies: string[];
}

interface ResearchOnboardingScreenProps {
  initialFirstName?: string;
  initialLastName?: string;
  onSubmit: (values: ResearchOnboardingValues) => void;
}

/**
 * One animation cadence so every element rises in the same staggered rhythm.
 *
 * The descending `zIndex` keeps each field (and its absolutely-positioned
 * autocomplete dropdown) painting above the rows below it: the entrance
 * `animation` makes every row its own stacking context, so a later row would
 * otherwise cover an earlier row's open dropdown.
 */
function riseIn(delaySeconds: number, zIndex?: number): React.CSSProperties {
  return {
    animation: `fadeInUp 0.4s ease-out ${delaySeconds}s both`,
    ...(zIndex != null ? { position: "relative", zIndex } : {}),
  };
}

export function ResearchOnboardingScreen({
  initialFirstName = "",
  initialLastName = "",
  onSubmit,
}: ResearchOnboardingScreenProps) {
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [role, setRole] = useState("");
  const [hobbies, setHobbies] = useState<string[]>([]);

  // First name + role are the minimum signal worth researching on.
  const canSubmit = firstName.trim().length > 0 && role.trim().length > 0;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit({ firstName, lastName, role, hobbies });
  }

  return (
    // Force the dark palette for the onboarding flow regardless of app theme —
    // `data-theme="dark"` re-declares the design tokens for this subtree (custom
    // props inherit down). Matches the brand onboarding design.
    <div data-theme="dark" className="h-full">
    <OnboardingLayout showCreatureFooter={false}>
      <OnboardingEdgeCharacters />
      <form
        className="relative z-10 mx-auto flex min-h-screen w-full max-w-sm flex-col items-center justify-center px-6 py-16 text-[var(--content-default)]"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <h1
          className="text-center font-serif text-[2.75rem] leading-[1.05] tracking-tight"
          style={riseIn(0.05)}
        >
          Let&apos;s start with you.
        </h1>

        <p
          className="mt-3 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={riseIn(0.12)}
        >
          A few details so I can get to know you.
        </p>

        <div className="mt-10 flex w-full flex-col gap-5">
          <div style={riseIn(0.2, 40)}>
            <Input
              label={
                <>
                  What should I call you?
                  <span
                    aria-hidden
                    className="text-[var(--system-negative-strong)]"
                  >
                    {" *"}
                  </span>
                </>
              }
              placeholder="Your name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoFocus
              required
              fullWidth
            />
          </div>

          <div style={riseIn(0.27, 30)}>
            <Input
              label="And your last name?"
              placeholder="Your last name (optional)"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              fullWidth
            />
          </div>

          <div style={riseIn(0.34, 20)}>
            <Input
              label="Your role"
              placeholder="What do you do for work?"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              required
              fullWidth
            />
          </div>

          <div style={riseIn(0.41, 10)}>
            <TagAutocompleteInput
              label="Any hobbies?"
              placeholder="Cars, books, growing tomatoes?"
              values={hobbies}
              onChange={setHobbies}
              suggestions={HOBBY_SUGGESTIONS}
            />
          </div>
        </div>

        <div className="mt-10 w-full" style={riseIn(0.5)}>
          <Button
            type="submit"
            variant="primary"
            size="regular"
            rightIcon={<ArrowRight size={16} />}
            fullWidth
            disabled={!canSubmit}
            className="h-11 text-base"
          >
            Continue
          </Button>
        </div>
      </form>
    </OnboardingLayout>
    </div>
  );
}
