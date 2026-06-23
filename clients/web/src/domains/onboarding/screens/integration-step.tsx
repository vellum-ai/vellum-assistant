/**
 * "Help me get oriented, and get free credits" step content.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only (the toned backdrop sits behind). Offers free credits in
 * exchange for connecting Google Calendar. Claim opens the real managed Google
 * Calendar OAuth (calendar.events + identity scopes) right inside the click —
 * the popup must open within the user gesture — and plays the coin flourish
 * (drops toward the eyes, the eyes bump it Mario-style, it pops up and
 * vanishes). On a successful grant the parent fires the Day-2 check-in and
 * advances straight to "Meeting Created!", so the standalone calendar step is no
 * longer needed in the happy path. Skippable.
 */

import { useEffect, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { OnboardingCoin } from "@/domains/onboarding/components/onboarding-coin";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useGoogleCalendarConnect } from "@/domains/onboarding/hooks/use-google-calendar-connect";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

interface IntegrationStepProps {
  /** Hatched assistant id; null until the background hatch resolves. */
  assistantId: string | null;
  /** True once the hatch is fully healthy (daemon reachable), not just hatched. */
  assistantReady: boolean;
  /** Fired once the Google Calendar grant lands, with the scopes granted. */
  onConnected: (scopes: string[]) => void;
  /** Skip the calendar connect and move on. */
  onSkip: () => void;
  /** Fire the eyes' upward jolt as the coin reaches them. */
  onBumpEyes: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}

/** Coin drop → bump → quick gravity arc up + back down (seconds). The fall is
 *  faster than real gravity for snappiness. `DROP` is when the eyes bump. */
const DROP = 0.3;
const TOTAL = 0.95;

export function IntegrationStep({
  assistantId,
  assistantReady,
  onConnected,
  onSkip,
  onBumpEyes,
  onBack,
  onForward,
}: IntegrationStepProps) {
  const reduce = useReducedMotion();
  const tone = useOnboardingTone();
  // `claiming` covers the coin flourish; `coinDone` flips once it has flown
  // away, after which we surface the OAuth-in-progress state.
  const [claiming, setClaiming] = useState(false);
  const [coinDone, setCoinDone] = useState(false);

  const { handleConnect, oauthInProgress } = useGoogleCalendarConnect({
    assistantId: assistantId ?? "",
    onConnect: onConnected,
  });
  // Gate Claim on full hatch readiness (not just an id): the post-OAuth
  // `scheduleCheckin` talks to the daemon, which may not be reachable until
  // healthz passes — a grant against a not-yet-reachable daemon would silently
  // no-op while the flow advanced.
  const claimDisabled = !assistantId || !assistantReady || oauthInProgress;

  // An OAuth that ends without success (popup closed / declined / blocked)
  // flips `oauthInProgress` back to false while we're still mounted — a
  // successful grant would have advanced the flow and unmounted us. Reset so the
  // Claim button is offered again instead of stranding the user on a vanished
  // coin.
  useEffect(() => {
    if (claiming && coinDone && !oauthInProgress) {
      setClaiming(false);
      setCoinDone(false);
    }
  }, [claiming, coinDone, oauthInProgress]);

  function handleClaim() {
    if (claimDisabled || claiming) return;
    // Open the OAuth popup inside the click gesture (popup blockers require the
    // window.open to happen synchronously here), then play the coin flourish.
    handleConnect();
    setClaiming(true);
    if (reduce) {
      setCoinDone(true);
      return;
    }
    // Bump the eyes right as the coin reaches the bottom.
    window.setTimeout(onBumpEyes, DROP * 1000);
  }

  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const dropY = vh * 0.42; // down to the eyes
  const apexY = -vh * 0.08; // bumped just a little above the start
  const fallY = vh * 0.9; // falls away off the bottom

  const waiting = claiming && coinDone && oauthInProgress;

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[26%] flex -translate-x-1/2 flex-col items-center gap-3 px-6 text-center">
        <h1
          className="text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Help me get oriented, and get free credits
        </h1>
        <p className="text-[16px]" style={{ color: tone.fgMuted }}>
          Connect your calendar and I&rsquo;ll find time tomorrow to check in
          with you.
        </p>

        {/* Coin — drops to the eyes, gets bumped up, then falls away (2D flight
            here) while the coin spins in its own 3D context (`spinning`). */}
        <div className="mt-8 flex flex-col items-center gap-4">
          <motion.div
            animate={
              claiming && !reduce
                ? {
                    y: [0, dropY, apexY, fallY],
                    scale: [1, 1, 1, 0.2],
                    opacity: [1, 1, 1, 0],
                  }
                : {}
            }
            transition={{
              duration: TOTAL,
              // Fall into the eyes, get bumped up (decelerating like gravity),
              // then accelerate back down — a quick parabolic arc.
              times: [0, DROP / TOTAL, 0.62, 1],
              ease: ["easeIn", "easeOut", "easeIn"],
            }}
            onAnimationComplete={() => {
              if (claiming) setCoinDone(true);
            }}
          >
            <OnboardingCoin size={88} spinning={claiming && !reduce} />
          </motion.div>
        </div>

        {/* Claim opens the OAuth flow; once the coin has flown we surface the
            in-progress state until the grant lands (or the popup is dismissed). */}
        {!claiming && (
          <button
            type="button"
            onClick={handleClaim}
            disabled={claimDisabled}
            className="mt-6 flex h-11 w-[234px] items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition-transform duration-150 active:scale-[0.97] disabled:opacity-60"
            style={{
              backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
              color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
            }}
          >
            Claim free credits
            <ArrowRight className="h-4 w-4" />
          </button>
        )}
        {waiting && (
          <div
            className="mt-6 flex h-11 w-[234px] items-center justify-center gap-2 rounded-[10px] text-body-medium-default opacity-80"
            style={{
              backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
              color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
            }}
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Waiting for authorization…
          </div>
        )}
      </div>

      {/* Skip sits down near the bottom, just above the peeking eyes. */}
      <button
        type="button"
        onClick={onSkip}
        disabled={oauthInProgress}
        className="absolute bottom-[26%] left-1/2 -translate-x-1/2 text-body-small-default transition-opacity hover:opacity-100 disabled:opacity-60"
        style={{ color: tone.fgMuted }}
      >
        Skip for now
      </button>
    </div>
  );
}
