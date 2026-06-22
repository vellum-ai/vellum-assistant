/**
 * "We're giving you 10 free credits" step content.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only (the toned backdrop sits behind). Grants 10 free credits. The
 * coin itself is the action: clicking it drops the coin toward the eyes, the
 * eyes bump it up Mario-style, and it pops up and vanishes — then the flow
 * advances. If the user hasn't clicked after a few seconds, a little character
 * pops in with a "click it!" nudge. Not skippable.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingCoin } from "@/domains/onboarding/components/onboarding-coin";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { pickOverlayColors } from "@/domains/onboarding/onboarding-avatar-colors";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

interface IntegrationStepProps {
  onClaim: () => void;
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

/** How long the user can sit on the coin before the "click it!" nudge appears. */
const NUDGE_DELAY_MS = 5000;

export function IntegrationStep({
  onClaim,
  onBumpEyes,
  onBack,
  onForward,
}: IntegrationStepProps) {
  const reduce = useReducedMotion();
  const tone = useOnboardingTone();
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const [claiming, setClaiming] = useState(false);
  const [showNudge, setShowNudge] = useState(false);

  // A little character (in a contrasting overlay color) for the nudge.
  const nudgeTraits = useMemo(() => {
    const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;
    const color =
      components && chosen
        ? pickOverlayColors(
            chosen.color,
            components.colors.map((c) => c.id),
            1,
          )[0]
        : undefined;
    return { bodyShape: "blob", eyeStyle: "quirky", color: color ?? "yellow" };
  }, [components, characters, selectedIndex]);

  // Nudge the user if they haven't claimed after a beat.
  useEffect(() => {
    if (claiming) return;
    const t = window.setTimeout(() => setShowNudge(true), NUDGE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [claiming]);

  function handleClaim() {
    if (claiming) return;
    setClaiming(true);
    setShowNudge(false);
    if (reduce) {
      onClaim();
      return;
    }
    // Bump the eyes right as the coin reaches the bottom.
    window.setTimeout(onBumpEyes, DROP * 1000);
  }

  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const dropY = vh * 0.42; // down to the eyes
  const apexY = -vh * 0.08; // bumped just a little above the start
  const fallY = vh * 0.9; // falls away off the bottom

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[26%] flex -translate-x-1/2 flex-col items-center gap-3 px-6 text-center">
        <h1
          className="max-w-[640px] text-[2.6rem] leading-tight"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Here&rsquo;s 10 free credits to get started!
        </h1>

        {/* Coin — the click target. Drops to the eyes, gets bumped up, then
            falls away (2D flight here) while the coin spins in its own 3D
            context (`spinning`). */}
        <div className="mt-10 flex flex-col items-center gap-4">
          <div className="relative">
            <motion.button
              type="button"
              onClick={handleClaim}
              disabled={claiming}
              aria-label="Claim your 10 free credits"
              className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-default enabled:cursor-pointer"
              animate={
                claiming && !reduce
                  ? {
                      y: [0, dropY, apexY, fallY],
                      scale: [1, 1, 1, 0.2],
                      opacity: [1, 1, 1, 0],
                    }
                  : reduce
                    ? {}
                    : { y: [0, -9, 0] }
              }
              transition={
                claiming
                  ? {
                      duration: TOTAL,
                      // Fall into the eyes, get bumped up (decelerating like
                      // gravity), then accelerate back down — a parabolic arc.
                      times: [0, DROP / TOTAL, 0.62, 1],
                      ease: ["easeIn", "easeOut", "easeIn"],
                    }
                  : { duration: 2.2, repeat: Infinity, ease: "easeInOut" }
              }
              onAnimationComplete={() => {
                if (claiming) onClaim();
              }}
            >
              <OnboardingCoin size={88} spinning={claiming && !reduce} />
            </motion.button>

            {/* "click it!" nudge — a little character that slides in from the
                right with a speech bubble, shown only if they've lingered and
                haven't claimed yet. */}
            {showNudge && !claiming && (
              <motion.div
                className="pointer-events-none absolute left-full top-1/2 ml-20 flex -translate-y-1/2 flex-col items-center"
                initial={reduce ? false : { opacity: 0, x: 120 }}
                animate={{ opacity: 1, x: 0 }}
                transition={
                  reduce ? { duration: 0 } : { type: "spring", stiffness: 220, damping: 22 }
                }
              >
                <div className="relative mb-1.5 whitespace-nowrap rounded-2xl bg-white px-3.5 py-1.5 text-[15px] font-medium text-[#1A1A1A] shadow-md">
                  click it!
                  {/* Tail pointing down to the character. */}
                  <span className="absolute -bottom-1 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 bg-white" />
                </div>
                {components && (
                  <AnimatedAvatar components={components} traits={nudgeTraits} size={76} />
                )}
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
