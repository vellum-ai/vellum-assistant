import { useNavigate } from "react-router";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import type { StalledApplyAction } from "./primitives";
import {
  CreatureCorners,
  STALLED_UPGRADE_WARNING,
  StalledApplyControls,
  WizardCardHeading,
} from "./primitives";
import { usePreferredOrActiveAssistant } from "./use-preferred-or-active-assistant";

/** Shown while a backgrounded resize is still finishing; cleared once done. */
const OFFLINE_WHILE_RESIZING =
  "Assistant will go offline briefly while it resizes. Chat might not work during that time.";

export function CompleteState({
  finishedInBackground = false,
  stalledAction,
  assistantId,
}: {
  /** The user backgrounded the machine resize; hidden once it completes. */
  finishedInBackground?: boolean;
  /** Set only while the backgrounded resize is stalled — offers manual apply. */
  stalledAction?: StalledApplyAction;
  /** The provisioning target assistant (onboarding primary, else active). */
  assistantId?: string | null;
}) {
  const navigate = useNavigate();
  const isOrgReady = useIsOrgReady();
  const assistant = usePreferredOrActiveAssistant(assistantId, isOrgReady);
  const assistantName = assistant?.name || "your assistant";

  return (
    <div className="relative flex min-h-[320px] flex-col items-center overflow-hidden px-8 pb-10 [animation:onboarding-step-in_350ms_ease-out] motion-reduce:[animation:none]">
      <CreatureCorners variant="full" />

      {/* `relative` lifts the content above the absolute creature layer. */}
      <div className="relative flex w-full flex-col items-center">
        <WizardCardHeading
          title="You're all set!"
          subtitle="Enjoy the new found power."
        />

        <div className="mt-8 flex w-full flex-col items-center gap-4">
          {stalledAction ? (
            <div className="flex w-full flex-col items-center gap-2">
              <Notice tone="warning" className="w-full text-left">
                {STALLED_UPGRADE_WARNING}
              </Notice>
              <StalledApplyControls
                action={stalledAction}
                buttonVariant="outlined"
                buttonTestId="complete-stalled-apply"
              />
            </div>
          ) : (
            finishedInBackground && (
              <Notice tone="neutral" className="w-full text-left">
                {OFFLINE_WHILE_RESIZING}
              </Notice>
            )
          )}

          <Button
            variant="primary"
            data-testid="onboarding-complete-return"
            onClick={() => navigate(routes.assistant, { replace: true })}
          >
            Return to {assistantName}
          </Button>
        </div>
      </div>
    </div>
  );
}
