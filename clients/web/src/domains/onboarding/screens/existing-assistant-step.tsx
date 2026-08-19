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
import {
  ONBOARDING_DARK_SURFACE,
  ONBOARDING_STEP_CONTENT,
} from "@/domains/onboarding/onboarding-step-layout";
import { usePublishPageSurface } from "@/stores/page-surface-store";
import { useTranslation } from "@/i18n";

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
  const { t } = useTranslation("onboarding");
  // The screen owns the whole viewport, so the shell paints its safe-area
  // strips to match. See `page-surface-store`.
  usePublishPageSurface(ONBOARDING_DARK_SURFACE);
  const name = assistantName?.trim() || "";
  const hasName = name.length > 0;

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
            {hasName
              ? t("existingAssistantStep.titleNamed", { name })
              : t("existingAssistantStep.title")}
          </h1>
          <p
            className="text-[15px]"
            style={{ color: "var(--content-secondary)" }}
          >
            {hasName
              ? t("existingAssistantStep.bodyNamed", { name })
              : t("existingAssistantStep.body")}
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
            {hasName
              ? t("existingAssistantStep.keepNamed", { name })
              : t("existingAssistantStep.keep")}
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onRedo}
            className="h-11 text-base"
          >
            {hasName
              ? t("existingAssistantStep.redoNamed", { name })
              : t("existingAssistantStep.redo")}
          </Button>
        </div>
      </div>
    </div>
  );
}
