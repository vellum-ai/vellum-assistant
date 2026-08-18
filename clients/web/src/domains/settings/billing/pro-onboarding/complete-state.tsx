import { useNavigate } from "react-router";

import { setSelectedAssistant } from "@/assistant/selection";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

import { CreatureCorners, WizardCardHeading } from "./primitives";
import { takeoverCopy, type TakeoverDirection } from "./takeover-copy";
import { usePreferredOrActiveAssistant } from "./use-preferred-or-active-assistant";

export function CompleteState({
  assistantId,
  direction,
}: {
  /** The provisioning target assistant (onboarding primary, else active). */
  assistantId?: string | null;
  /** Which way the change that just landed went. */
  direction?: TakeoverDirection;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation("settings");
  const isOrgReady = useIsOrgReady();
  const assistant = usePreferredOrActiveAssistant(assistantId, isOrgReady);
  const assistantName =
    assistant?.name || t("completeState.assistantFallbackName");

  return (
    <div className="relative flex min-h-[320px] flex-col items-center justify-center overflow-hidden px-8 pb-16 [animation:onboarding-step-in_350ms_ease-out] motion-reduce:[animation:none]">
      <CreatureCorners variant="full" />

      {/* `relative` lifts the content above the absolute creature layer. */}
      <div className="relative flex w-full flex-col items-center">
        <WizardCardHeading
          title={t("completeState.title")}
          subtitle={takeoverCopy(direction).completeSubtitle}
        />

        <div className="mt-10 flex w-full flex-col items-center gap-10">
          <Button
            variant="primary"
            data-testid="onboarding-complete-return"
            onClick={() => {
              // Provisioning can target an assistant other than the active
              // one, and the label names that target — select it first or the
              // click lands on whichever assistant was already active. The
              // reactive write is synchronous; only the lockfile mirror awaits.
              if (assistantId != null) {
                void setSelectedAssistant(assistantId);
              }
              navigate(routes.assistant, { replace: true });
            }}
          >
            {t("completeState.returnTo", { assistantName })}
          </Button>
        </div>
      </div>
    </div>
  );
}
