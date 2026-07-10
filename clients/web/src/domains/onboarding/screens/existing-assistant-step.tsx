/**
 * Guard step shown when the research-onboarding flow is about to run against
 * an assistant that already has a life — lived conversations and (usually) a
 * customized persona. Re-running the flow researches the user again and
 * REWRITES the persona, so it never proceeds silently: the primary action
 * keeps the assistant as-is and enters the app; redoing is an explicit,
 * consequence-labeled choice. A genuinely new user never sees this screen.
 */

import { ArrowRight } from "lucide-react";
import { Button } from "@vellumai/design-library/components/button";

import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { ONBOARDING_STEP_CONTENT } from "@/domains/onboarding/onboarding-step-layout";

interface ExistingAssistantStepProps {
  /** Current name of the established assistant, when known. */
  assistantName: string | null;
  /** Keep the assistant untouched and enter the app. */
  onKeep: () => void;
  /** Deliberately redo onboarding, overwriting the current persona. */
  onRedo: () => void;
  onBack: () => void;
}

export function ExistingAssistantStep({
  assistantName,
  onKeep,
  onRedo,
  onBack,
}: ExistingAssistantStepProps) {
  const name = assistantName?.trim() || "";
  const subject = name || "your assistant";
  const possessive = name ? `${name}'s` : "its";

  return (
    <div
      data-theme="dark"
      className="relative h-full overflow-hidden"
      style={{
        backgroundColor: "var(--surface-base)",
        color: "var(--content-primary)",
      }}
    >
      <OnboardingTopBar onBack={onBack} tone="light" />

      <div className={`${ONBOARDING_STEP_CONTENT} max-w-xl`}>
        <div className="flex flex-col items-center gap-3">
          <h1
            className="text-[2.2rem] leading-none"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            {name
              ? `${name} is already up and running`
              : "Your assistant is already up and running"}
          </h1>
          <p
            className="text-[15px]"
            style={{ color: "var(--content-secondary)" }}
          >
            You two have history — a personality, memories, and past
            conversations. Running setup again would overwrite who {subject} is
            now.
          </p>
        </div>

        <div className="flex w-full max-w-sm flex-col items-center gap-3">
          <Button
            variant="primary"
            size="regular"
            fullWidth
            onClick={onKeep}
            className="h-11 text-base"
          >
            Keep {subject} and start chatting
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onRedo}
            className="h-11 text-base"
          >
            Start over and rebuild {possessive} personality
          </Button>
        </div>
      </div>
    </div>
  );
}
