import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { createPortal } from "react-dom";

import { PLATFORM_HOSTED_DISABLED_MESSAGE } from "@/assistant/lifecycle";
import { useTranslation } from "@/i18n";

interface HatchErrorOverlayProps {
  /** Terminal failure message from the background hatch. */
  error: string;
  /** Re-run the failed hatch from the top. */
  onRetry: () => void;
}

/**
 * Terminal background-hatch failure, surfaced over the onboarding funnel.
 *
 * A non-modal banner: it layers on top of whatever step is on screen without
 * trapping focus or swallowing pointer events, so the funnel keeps both its
 * collected state and its own escapes (each step's back chevron, the calendar
 * step's "Skip for now") while the failure is up, and a successful retry
 * resumes in place. Retrying can't help while managed hosting is at capacity,
 * so that case offers the local-assistant off-ramp instead.
 *
 * Portaled to `document.body` so no step's stacking or clipping context can
 * bury it. Onboarding routes suppress the shell's top inset entirely (see
 * `utils/status-banner-visibility.ts`), so nothing upstream reserves the notch
 * and this banner adds it itself. Anchored to the top strip, which every step
 * reserves for chrome: bottom-anchored it would sit exactly over the results
 * step's viewport-pinned Continue, the only way forward from there. The offset
 * stacks the inset on top of `OnboardingTopBar`'s un-inset chevrons (`top-6` +
 * `h-10`), so it clears both them and the notch.
 */
export function HatchErrorOverlay({ error, onRetry }: HatchErrorOverlayProps) {
  const { t } = useTranslation("onboarding");
  const platformHostedDisabled = error === PLATFORM_HOSTED_DISABLED_MESSAGE;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+5rem)]">
      <Notice
        tone="error"
        title={t("hatchingScreen.genericFailure")}
        className="pointer-events-auto w-auto max-w-[480px] shadow-xl"
        actions={
          platformHostedDisabled ? (
            <Button asChild variant="primary" size="regular">
              <a href={`${window.location.origin}/download`}>
                {t("actions.downloadMacApp")}
              </a>
            </Button>
          ) : (
            <Button variant="primary" size="regular" onClick={onRetry}>
              {t("actions.tryAgain")}
            </Button>
          )
        }
      >
        {error}
        {platformHostedDisabled ? (
          <p className="mt-1 text-[color:var(--content-default)]">
            {t("hatchingScreen.localFallbackPitch")}
          </p>
        ) : null}
      </Notice>
    </div>,
    document.body,
  );
}
