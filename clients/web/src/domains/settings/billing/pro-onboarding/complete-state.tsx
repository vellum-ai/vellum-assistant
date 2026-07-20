import { PartyPopper } from "lucide-react";

import { useNavigate } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import type { StalledApplyAction } from "./provisioning-state";
import { extractOnboardingErrorMessage } from "./utils";

export function CompleteState({
  finishedInBackground = false,
  stalled = false,
  stalledAction,
}: {
  /** The user backgrounded the machine resize; hidden once it completes. */
  finishedInBackground?: boolean;
  /** The backgrounded resize stalled — offer the manual apply instead. */
  stalled?: boolean;
  stalledAction?: StalledApplyAction;
}) {
  const navigate = useNavigate();
  const isOrgReady = useIsOrgReady();
  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled: isOrgReady,
  });
  const assistantName = activeAssistant?.name || "your assistant";

  return (
    <div className="relative flex min-h-[320px] flex-col items-center justify-center overflow-hidden px-8 text-center">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 38%, color-mix(in oklab, var(--system-positive-strong) 14%, transparent), transparent)",
        }}
        aria-hidden="true"
      />

      <div className="relative mb-5 flex items-center justify-center [animation:welcome-reveal_600ms_ease-out_both] motion-reduce:[animation:none]">
        <div
          className="absolute h-24 w-24 rounded-full [animation:welcome-crown-glow_3s_ease-in-out_infinite] motion-reduce:[animation:none]"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklab, var(--system-positive-strong) 18%, transparent), transparent 70%)",
          }}
          aria-hidden="true"
        />
        <div
          className="absolute h-16 w-16 rounded-full [animation:welcome-crown-glow_3s_ease-in-out_infinite_0.5s] motion-reduce:[animation:none]"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklab, var(--system-positive-strong) 12%, transparent), transparent 70%)",
          }}
          aria-hidden="true"
        />
        <PartyPopper
          className="relative h-8 w-8 text-[var(--system-positive-strong)]"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </div>

      <h1
        className="relative mb-2 text-[var(--content-emphasised)] [animation:welcome-reveal_600ms_ease-out_150ms_both] motion-reduce:[animation:none]"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: "28px",
          lineHeight: 1,
          fontWeight: 400,
        }}
      >
        You&apos;re all set
      </h1>

      <p className="relative mb-6 max-w-[320px] text-body-medium-lighter text-[var(--content-secondary)] [animation:welcome-reveal_600ms_ease-out_300ms_both] motion-reduce:[animation:none]">
        Your assistant just got a serious upgrade.
      </p>

      {stalled && stalledAction ? (
        <div className="relative -mt-4 mb-6 flex w-full flex-col items-center gap-2 [animation:welcome-reveal_600ms_ease-out_350ms_both] motion-reduce:[animation:none]">
          <Notice tone="warning" className="w-full text-left">
            We couldn&apos;t finish your machine upgrade automatically. Apply
            it now to finish — your assistant will briefly restart.
          </Notice>
          {stalledAction.error != null && (
            <Notice tone="error" className="w-full text-left">
              {extractOnboardingErrorMessage(
                stalledAction.error,
                "Couldn't apply changes. Please try again.",
              )}
            </Notice>
          )}
          <Button
            variant="outlined"
            data-testid="complete-stalled-apply"
            disabled={stalledAction.pending}
            onClick={stalledAction.onApply}
          >
            Apply &amp; Restart
          </Button>
        </div>
      ) : (
        finishedInBackground && (
          <p className="relative -mt-4 mb-6 max-w-[320px] text-body-small-default text-[var(--content-tertiary)] [animation:welcome-reveal_600ms_ease-out_350ms_both] motion-reduce:[animation:none]">
            We&apos;re finishing your machine upgrade in the background.
          </p>
        )
      )}

      <div className="[animation:welcome-reveal_600ms_ease-out_450ms_both] motion-reduce:[animation:none]">
        <Button
          variant="primary"
          data-testid="onboarding-complete-return"
          onClick={() => navigate(routes.assistant, { replace: true })}
        >
          Return to {assistantName}
        </Button>
      </div>
    </div>
  );
}
