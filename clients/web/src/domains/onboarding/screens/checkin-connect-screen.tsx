import { ChevronLeft, Loader2 } from "lucide-react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { useGoogleCalendarConnect } from "@/domains/onboarding/hooks/use-google-calendar-connect";
import { isElectron } from "@/runtime/is-electron";
import { publicAsset } from "@/utils/public-asset";
import { Button } from "@vellumai/design-library/components/button";

interface CheckinConnectScreenProps {
  assistantId: string;
  assistantName: string;
  onConnect: (scopes: string[]) => void;
  onSkip: () => void;
  /** Optional — omitted when shown as a focused-overlay step (no back target). */
  onBack?: () => void;
}

/**
 * SPIKE — checkin-onboarding flow.
 *
 * "Let's chat tomorrow" page: invites the user to connect Google Calendar
 * (calendar.events only) so the assistant can schedule a Day 2 Check-in.
 * Connect/skip are driven by the parent route, which fires the check-in prompt
 * and continues the onboarding handoff.
 */
export function CheckinConnectScreen({
  assistantId,
  assistantName,
  onConnect,
  onSkip,
  onBack,
}: CheckinConnectScreenProps) {
  const electron = isElectron();
  const { handleConnect, oauthInProgress } = useGoogleCalendarConnect({
    assistantId,
    onConnect,
  });

  const assistantInlineName = assistantName || "your assistant";

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div
        className={`mx-auto flex w-full max-w-md flex-col items-center ${electron ? "min-h-full px-8 pt-11 pb-8 electron-prechat-type" : "px-6 pt-12 pb-40"} text-[var(--content-default)]`}
      >
        <div
          className="grid w-full grid-cols-[auto_1fr_auto] items-center"
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
          ) : (
            <div aria-hidden="true" className="h-8 w-8" />
          )}
          <h1
            className={`text-center ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}
          >
            Let&rsquo;s chat tomorrow
          </h1>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>

        <p
          className="mt-4 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          Add a meeting in your calendar so we can pick up where we left off.
        </p>

        <div
          className="mt-6 flex items-stretch justify-center"
          style={{ animation: "fadeInUp 0.3s ease-out 0.2s both" }}
        >
          <div className="flex w-28 flex-col items-center gap-2.5 rounded-2xl bg-[var(--surface-lift)] px-3 pb-3 pt-4">
            <img
              src={publicAsset("/images/integrations/google-calendar.svg")}
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 object-contain"
              loading="eager"
            />
            <span className="text-center text-xs leading-tight text-[var(--content-tertiary)]">
              Google Calendar
            </span>
          </div>
        </div>

        <p
          className="mt-8 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.25s both" }}
        >
          {`${assistantInlineName} will add a single Day 2 Check-in event. It only gets permission to manage calendar events — nothing else — and you can disconnect at any time.`}
        </p>

        <div
          className={`${electron ? "mt-auto" : "mt-8"} flex w-full flex-col gap-2`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.35s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            onClick={handleConnect}
            disabled={oauthInProgress}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            {oauthInProgress ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Waiting for authorization...
              </span>
            ) : (
              "Connect Google Calendar"
            )}
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            disabled={oauthInProgress}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            Skip for now
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
